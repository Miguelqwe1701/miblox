import {
  BasePart,
  CFrame,
  Color3,
  DataModel,
  Humanoid,
  Instance as EngineInstance,
  Model,
  Player,
  Players,
  PhysicsWorld,
  RemoteEvent,
  RemoteFunction,
  BindableEvent,
  Signal,
  Terrain,
  UDim,
  UDim2,
  Vector2,
  Vector3,
  Workspace,
  createInstance,
  isRegisteredClass,
  buildAvatar,
  describeAvatar,
  fromDescriptionInstance,
  toDescriptionInstance,
  HumanoidDescription,
  MATERIAL_ID,
} from "@miblox/core";
import {
  LuaError,
  LuaTable,
  isFunction,
  nativeFn,
  truthy,
  userdata,
  yieldingFn,
  type LuaFunction,
  type LuaUserdata,
  type LuaValue,
  type LuauVM,
} from "@miblox/luau";
import {
  asCFrame,
  asColor3,
  asVector3,
  isWrapped,
  wrapCFrame,
  wrapColor3,
  wrapUDim,
  wrapUDim2,
  wrapValue,
  wrapVector2,
  wrapVector3,
} from "./datatypes.js";

export interface BridgeContext {
  game: DataModel;
  vm: LuauVM;
  physics: PhysicsWorld;
  /** Which side this VM runs on; gates server-only members. */
  side: "server" | "client";
  /** Reports a script error without killing the server. */
  onError?: (err: unknown) => void;
}

/**
 * Bridges the engine's Instance tree into Luau.
 *
 * Each engine Instance gets one cached proxy table whose metatable resolves
 * members in Roblox's order: methods, then properties, then children by name.
 * The engine objects are never copied, so `part.CFrame = cf` writes straight
 * through to the simulation and the replication journal.
 */
export class InstanceBridge {
  private readonly proxies = new WeakMap<EngineInstance, LuaTable>();
  private readonly signalProxies = new WeakMap<Signal<never>, LuaUserdata>();
  private readonly instanceMeta: LuaTable;
  private readonly signalMeta: LuaTable;
  private readonly connectionMeta: LuaTable;

  constructor(private readonly ctx: BridgeContext) {
    this.instanceMeta = this.buildInstanceMetatable();
    this.signalMeta = this.buildSignalMetatable();
    this.connectionMeta = this.buildConnectionMetatable();
  }

  // -- conversion ----------------------------------------------------------

  /** Engine value -> Luau value. */
  toLua(value: unknown): LuaValue {
    if (value === undefined || value === null) return undefined;
    if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
      return value;
    }
    if (value instanceof Vector3) return wrapVector3(value);
    if (value instanceof Vector2) return wrapVector2(value);
    if (value instanceof CFrame) return wrapCFrame(value);
    if (value instanceof Color3) return wrapColor3(value);
    if (value instanceof UDim2) return wrapUDim2(value);
    if (value instanceof UDim) return wrapUDim(value);
    if (value instanceof EngineInstance) return this.wrapInstance(value);
    if (value instanceof Signal) return this.wrapSignal(value as Signal<never>);
    if (Array.isArray(value)) return LuaTable.fromArray(value.map((v) => this.toLua(v)));
    if (value instanceof LuaTable) return value;
    if (isFunction(value as LuaValue)) return value as LuaValue;
    // Anything else is opaque to scripts but can still be passed around.
    return userdata("userdata", value);
  }

  /** Luau value -> engine value, for property writes and method arguments. */
  toEngine(value: LuaValue): unknown {
    if (value === undefined) return undefined;
    if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
      return value;
    }
    if (value instanceof LuaTable) {
      const inst = value.get("__instance");
      if (inst !== undefined) return (inst as LuaUserdata).value;
      return value;
    }
    if (isWrapped(value, "Vector3")) return asVector3(value);
    if (isWrapped(value, "CFrame")) return asCFrame(value);
    if (isWrapped(value, "Color3")) return asColor3(value);
    if (isWrapped(value, "UDim2") || isWrapped(value, "UDim")) return (value as LuaUserdata).value;
    if (isWrapped(value, "Vector2") || isWrapped(value, "userdata")) {
      return (value as LuaUserdata).value;
    }
    return value;
  }

  /** Unwraps an instance argument, throwing a Lua-style error if it is not one. */
  asInstance(value: LuaValue, where: string): EngineInstance {
    const unwrapped = this.toEngine(value);
    if (unwrapped instanceof EngineInstance) return unwrapped;
    throw new LuaError(`${where} expected an Instance`);
  }

  wrapInstance(inst: EngineInstance): LuaTable {
    const existing = this.proxies.get(inst);
    if (existing) return existing;
    const proxy = new LuaTable();
    // The engine object rides along inside the proxy so toEngine can find it.
    proxy.set("__instance", userdata("Instance", inst));
    proxy.metatable = this.instanceMeta;
    this.proxies.set(inst, proxy);
    return proxy;
  }

  private static unwrap(self: LuaValue): EngineInstance {
    if (!(self instanceof LuaTable)) throw new LuaError("expected an Instance");
    const holder = self.get("__instance");
    if (holder === undefined) throw new LuaError("expected an Instance");
    return (holder as LuaUserdata).value as EngineInstance;
  }

  // -- signals -------------------------------------------------------------

  wrapSignal(signal: Signal<never>): LuaUserdata {
    const existing = this.signalProxies.get(signal);
    if (existing) return existing;
    const wrapped = userdata("RBXScriptSignal", signal, this.signalMeta);
    this.signalProxies.set(signal, wrapped);
    return wrapped;
  }

  private buildSignalMetatable(): LuaTable {
    const mt = new LuaTable();
    mt.set("__type", "RBXScriptSignal");

    const connect = (once: boolean) =>
      nativeFn(once ? "Once" : "Connect", (args) => {
        const signal = (args[0] as LuaUserdata).value as Signal<unknown[]>;
        const handler = args[1];
        if (!isFunction(handler)) {
          throw new LuaError("Connect expects a function");
        }
        const method = once ? signal.Once : signal.Connect;
        const connection = method.call(signal, (...fired: unknown[]) => {
          // Each handler runs on its own thread, so a handler that yields
          // cannot block the engine code that fired the signal.
          this.ctx.vm.scheduler.spawn(
            handler as LuaFunction,
            fired.map((v) => this.toLua(v)),
          );
        });
        return [userdata("RBXScriptConnection", connection, this.connectionMeta)];
      });

    mt.set(
      "__index",
      nativeFn("RBXScriptSignal.__index", (args) => {
        const key = args[1];
        switch (key) {
          case "Connect": return [connect(false)];
          case "Once": return [connect(true)];
          case "Wait":
            return [
              yieldingFn("Wait", function* (waitArgs) {
                const signal = (waitArgs[0] as LuaUserdata).value as Signal<unknown[]>;
                // Suspends this thread until the signal next fires.
                const resumed = yield {
                  kind: "waitPromise",
                  promise: signal.Wait().then((fired) => fired.map((v) => bridge.toLua(v))),
                };
                return resumed ?? [];
              }),
            ];
          case "ConnectParallel": return [connect(false)];
          default:
            throw new LuaError(`${String(key)} is not a valid member of RBXScriptSignal`);
        }
      }),
    );
    // `bridge` is captured by the generator above, which cannot see `this`.
    const bridge = this;
    mt.set("__tostring", nativeFn("tostring", () => ["Signal"]));
    return mt;
  }

  private buildConnectionMetatable(): LuaTable {
    const mt = new LuaTable();
    mt.set("__type", "RBXScriptConnection");
    mt.set(
      "__index",
      nativeFn("RBXScriptConnection.__index", (args) => {
        const conn = (args[0] as LuaUserdata).value as { Connected: boolean; Disconnect(): void };
        switch (args[1]) {
          case "Connected": return [conn.Connected];
          case "Disconnect":
            return [
              nativeFn("Disconnect", (a) => {
                ((a[0] as LuaUserdata).value as { Disconnect(): void }).Disconnect();
                return [];
              }),
            ];
          default:
            throw new LuaError(`${String(args[1])} is not a valid member of RBXScriptConnection`);
        }
      }),
    );
    return mt;
  }

  // -- instance metatable --------------------------------------------------

  private buildInstanceMetatable(): LuaTable {
    const mt = new LuaTable();
    mt.set("__type", "Instance");

    mt.set(
      "__index",
      nativeFn("Instance.__index", (args) => {
        const inst = InstanceBridge.unwrap(args[0]);
        const key = args[1];
        if (typeof key !== "string") {
          throw new LuaError(`attempt to index an Instance with a ${typeof key}`);
        }

        // Roblox spells this with a capital C; the engine field is className.
        if (key === "ClassName") return [inst.className];

        // 1. Methods take priority, as they do in Roblox.
        const method = this.methodFor(inst, key);
        if (method) return [method];

        // 2. Then properties and events on the engine object itself.
        const raw = (inst as unknown as Record<string, unknown>)[key];
        if (raw !== undefined) return [this.toLua(raw)];

        // A property that exists but is currently nil must read as nil rather
        // than falling through to a child lookup.
        if (key in (inst as unknown as Record<string, unknown>)) return [undefined];

        // 3. Finally children by name.
        const child = inst.FindFirstChild(key);
        if (child) return [this.wrapInstance(child)];

        throw new LuaError(`${key} is not a valid member of ${inst.className} "${inst.GetFullName()}"`);
      }),
    );

    mt.set(
      "__newindex",
      nativeFn("Instance.__newindex", (args) => {
        const inst = InstanceBridge.unwrap(args[0]);
        const key = args[1];
        const value = args[2];
        if (typeof key !== "string") throw new LuaError("Instance keys must be strings");

        if (key === "Parent") {
          inst.setParent(value === undefined ? null : this.asInstance(value, "Parent"));
          return [];
        }
        if (key === "Name") {
          inst.Name = String(this.toEngine(value));
          inst.markDirty("Name");
          return [];
        }
        if (key === "ClassName") {
          throw new LuaError(`ClassName is not a valid member to set on ${inst.className}`);
        }

        const record = inst as unknown as Record<string, unknown>;
        if (!(key in record)) {
          throw new LuaError(`${key} is not a valid member of ${inst.className}`);
        }
        if (record[key] instanceof Signal) {
          throw new LuaError(`cannot assign to event ${key}`);
        }
        // setProperty is the single write path that feeds replication.
        inst.setProperty(key, this.toEngine(value));
        return [];
      }),
    );

    mt.set(
      "__tostring",
      nativeFn("Instance.__tostring", (args) => [InstanceBridge.unwrap(args[0]).Name]),
    );

    mt.set(
      "__eq",
      nativeFn("Instance.__eq", (args) => {
        try {
          return [InstanceBridge.unwrap(args[0]) === InstanceBridge.unwrap(args[1])];
        } catch {
          return [false];
        }
      }),
    );

    return mt;
  }

  // -- methods -------------------------------------------------------------

  /** Resolves a method name against the instance's class and its ancestors. */
  private methodFor(inst: EngineInstance, key: string): LuaFunction | undefined {
    const specific = this.specificMethod(inst, key);
    if (specific) return specific;
    return this.baseMethods()[key];
  }

  private baseMethodCache: Record<string, LuaFunction> | null = null;

  private baseMethods(): Record<string, LuaFunction> {
    if (this.baseMethodCache) return this.baseMethodCache;
    const m: Record<string, LuaFunction> = {};

    m.Destroy = nativeFn("Destroy", (a) => {
      InstanceBridge.unwrap(a[0]).Destroy();
      return [];
    });
    m.Clone = nativeFn("Clone", (a) => {
      const copy = InstanceBridge.unwrap(a[0]).Clone();
      return [copy ? this.wrapInstance(copy) : undefined];
    });
    m.FindFirstChild = nativeFn("FindFirstChild", (a) => {
      const child = InstanceBridge.unwrap(a[0]).FindFirstChild(String(a[1]), truthy(a[2]));
      return [child ? this.wrapInstance(child) : undefined];
    });
    m.FindFirstChildOfClass = nativeFn("FindFirstChildOfClass", (a) => {
      const child = InstanceBridge.unwrap(a[0]).FindFirstChildOfClass(String(a[1]));
      return [child ? this.wrapInstance(child) : undefined];
    });
    m.FindFirstChildWhichIsA = nativeFn("FindFirstChildWhichIsA", (a) => {
      const wanted = String(a[1]);
      const found = InstanceBridge.unwrap(a[0]).GetChildren().find((c) => c.IsA(wanted));
      return [found ? this.wrapInstance(found) : undefined];
    });
    m.FindFirstAncestor = nativeFn("FindFirstAncestor", (a) => {
      const found = InstanceBridge.unwrap(a[0]).FindFirstAncestor(String(a[1]));
      return [found ? this.wrapInstance(found) : undefined];
    });
    m.FindFirstAncestorOfClass = nativeFn("FindFirstAncestorOfClass", (a) => {
      const found = InstanceBridge.unwrap(a[0]).FindFirstAncestorOfClass(String(a[1]));
      return [found ? this.wrapInstance(found) : undefined];
    });
    m.GetChildren = nativeFn("GetChildren", (a) => [
      LuaTable.fromArray(
        InstanceBridge.unwrap(a[0]).GetChildren().map((c) => this.wrapInstance(c)),
      ),
    ]);
    m.GetDescendants = nativeFn("GetDescendants", (a) => [
      LuaTable.fromArray(
        InstanceBridge.unwrap(a[0]).GetDescendants().map((c) => this.wrapInstance(c)),
      ),
    ]);
    m.ClearAllChildren = nativeFn("ClearAllChildren", (a) => {
      for (const child of InstanceBridge.unwrap(a[0]).GetChildren()) child.Destroy();
      return [];
    });
    m.GetFullName = nativeFn("GetFullName", (a) => [InstanceBridge.unwrap(a[0]).GetFullName()]);
    m.IsA = nativeFn("IsA", (a) => [InstanceBridge.unwrap(a[0]).IsA(String(a[1]))]);
    m.IsDescendantOf = nativeFn("IsDescendantOf", (a) => [
      InstanceBridge.unwrap(a[0]).IsDescendantOf(this.asInstance(a[1], "IsDescendantOf")),
    ]);
    m.GetPropertyChangedSignal = nativeFn("GetPropertyChangedSignal", (a) => [
      this.wrapSignal(
        InstanceBridge.unwrap(a[0]).GetPropertyChangedSignal(String(a[1])) as Signal<never>,
      ),
    ]);

    const bridge = this;
    m.WaitForChild = yieldingFn("WaitForChild", function* (a) {
      const inst = InstanceBridge.unwrap(a[0]);
      const name = String(a[1]);
      const existing = inst.FindFirstChild(name);
      if (existing) return [bridge.wrapInstance(existing)];
      const timeout = typeof a[2] === "number" ? a[2] : undefined;
      const resumed = yield {
        kind: "waitPromise",
        promise: inst
          .WaitForChild(name, timeout)
          .then((child) => [child ? bridge.wrapInstance(child) : undefined]),
      };
      return resumed ?? [];
    });

    this.baseMethodCache = m;
    return m;
  }

  private specificMethod(inst: EngineInstance, key: string): LuaFunction | undefined {
    if (inst instanceof DataModel) {
      if (key === "GetService") {
        return nativeFn("GetService", (a) => {
          const name = String(a[1]);
          if (!isRegisteredClass(name) && !(inst as DataModel).FindService(name)) {
            throw new LuaError(`"${name}" is not a valid service name`);
          }
          return [this.wrapInstance((inst as DataModel).GetService(name))];
        });
      }
      if (key === "FindService") {
        return nativeFn("FindService", (a) => {
          const svc = (inst as DataModel).FindService(String(a[1]));
          return [svc ? this.wrapInstance(svc) : undefined];
        });
      }
    }

    if (inst instanceof Workspace && key === "Raycast") {
      return nativeFn("Raycast", (a) => {
        const origin = asVector3(a[1], "Workspace:Raycast");
        const direction = asVector3(a[2], "Workspace:Raycast");
        const params = a[3];
        const filter: EngineInstance[] = [];
        let filterType: "Exclude" | "Include" = "Exclude";
        if (params instanceof LuaTable) {
          const list = params.get("FilterDescendantsInstances");
          if (list instanceof LuaTable) {
            for (const [, v] of list.entries()) {
              const engine = this.toEngine(v);
              if (engine instanceof EngineInstance) filter.push(engine);
            }
          }
          const type = params.get("FilterType");
          if (type === "Include") filterType = "Include";
        }
        const hit = this.ctx.physics.raycast(origin, direction, {
          maxDistance: direction.magnitude,
          filterDescendantsInstances: filter,
          filterType,
        });
        if (!hit) return [undefined];
        const result = new LuaTable();
        result.set("Position", wrapVector3(hit.position));
        result.set("Normal", wrapVector3(hit.normal));
        result.set("Distance", hit.distance);
        result.set("Material", hit.material);
        result.set("Instance", hit.instance ? this.wrapInstance(hit.instance) : undefined);
        return [result];
      });
    }

    if (inst instanceof BasePart && key === "GetMass") {
      return nativeFn("GetMass", (a) => [(InstanceBridge.unwrap(a[0]) as BasePart).GetMass()]);
    }

    if (inst instanceof Model) {
      if (key === "MoveTo") {
        return nativeFn("MoveTo", (a) => {
          (InstanceBridge.unwrap(a[0]) as Model).MoveTo(asVector3(a[1], "Model:MoveTo"));
          return [];
        });
      }
      if (key === "SetPrimaryPartCFrame") {
        return nativeFn("SetPrimaryPartCFrame", (a) => {
          (InstanceBridge.unwrap(a[0]) as Model).SetPrimaryPartCFrame(
            asCFrame(a[1], "Model:SetPrimaryPartCFrame"),
          );
          return [];
        });
      }
      if (key === "GetPrimaryPartCFrame") {
        return nativeFn("GetPrimaryPartCFrame", (a) => [
          wrapCFrame((InstanceBridge.unwrap(a[0]) as Model).GetPrimaryPartCFrame()),
        ]);
      }
      if (key === "GetBoundingBox") {
        return nativeFn("GetBoundingBox", (a) => {
          const box = (InstanceBridge.unwrap(a[0]) as Model).GetBoundingBox();
          return [wrapCFrame(CFrame.fromPosition(box.center)), wrapVector3(box.size)];
        });
      }
    }

    if (inst instanceof Humanoid) {
      if (key === "TakeDamage") {
        return nativeFn("TakeDamage", (a) => {
          (InstanceBridge.unwrap(a[0]) as Humanoid).TakeDamage(Number(a[1]) || 0);
          return [];
        });
      }
      if (key === "Move") {
        return nativeFn("Move", (a) => {
          (InstanceBridge.unwrap(a[0]) as Humanoid).Move(
            asVector3(a[1], "Humanoid:Move"),
            truthy(a[2]),
          );
          return [];
        });
      }
      if (key === "GetState") {
        return nativeFn("GetState", (a) => [(InstanceBridge.unwrap(a[0]) as Humanoid).state]);
      }
      if (key === "ApplyDescription") {
        return nativeFn("ApplyDescription", (a) => {
          const humanoid = InstanceBridge.unwrap(a[0]) as Humanoid;
          const description = this.asInstance(a[1], "Humanoid:ApplyDescription");
          if (description.className !== "HumanoidDescription") {
            throw new LuaError("Humanoid:ApplyDescription expects a HumanoidDescription");
          }
          humanoid.ApplyDescription(description as HumanoidDescription);
          return [];
        });
      }
      if (key === "GetAppliedDescription") {
        return nativeFn("GetAppliedDescription", (a) => {
          const humanoid = InstanceBridge.unwrap(a[0]) as Humanoid;
          const description = humanoid.GetAppliedDescription();
          return [description ? this.wrapInstance(description) : undefined];
        });
      }
    }

    if (inst instanceof Terrain) {
      const materialId = (v: LuaValue): number => {
        if (typeof v === "number") return v;
        const name = String(v);
        const id = MATERIAL_ID[name];
        if (id === undefined) throw new LuaError(`"${name}" is not a terrain material`);
        return id;
      };
      if (key === "FillBlock") {
        return nativeFn("FillBlock", (a) => {
          const terrain = InstanceBridge.unwrap(a[0]) as Terrain;
          // FillBlock(centerCFrame, size, material), as Roblox defines it.
          const center = isWrapped(a[1], "CFrame")
            ? asCFrame(a[1]).position
            : asVector3(a[1], "Terrain:FillBlock");
          const size = asVector3(a[2], "Terrain:FillBlock");
          const half = size.mul(0.5);
          return [terrain.FillBlock(center.sub(half), center.add(half), materialId(a[3]))];
        });
      }
      if (key === "FillBall") {
        return nativeFn("FillBall", (a) => {
          const terrain = InstanceBridge.unwrap(a[0]) as Terrain;
          return [
            terrain.FillBall(
              asVector3(a[1], "Terrain:FillBall"),
              Number(a[2]) || 0,
              materialId(a[3]),
            ),
          ];
        });
      }
      if (key === "SetVoxel") {
        return nativeFn("SetVoxel", (a) => {
          const terrain = InstanceBridge.unwrap(a[0]) as Terrain;
          return [
            terrain.SetVoxel(Number(a[1]) | 0, Number(a[2]) | 0, Number(a[3]) | 0, materialId(a[4])),
          ];
        });
      }
      if (key === "GetVoxel") {
        return nativeFn("GetVoxel", (a) => {
          const terrain = InstanceBridge.unwrap(a[0]) as Terrain;
          return [terrain.GetVoxel(Number(a[1]) | 0, Number(a[2]) | 0, Number(a[3]) | 0)];
        });
      }
      if (key === "GetSurfaceHeight") {
        return nativeFn("GetSurfaceHeight", (a) => {
          const terrain = InstanceBridge.unwrap(a[0]) as Terrain;
          return [terrain.voxels.surfaceHeight(Number(a[1]) || 0, Number(a[2]) || 0)];
        });
      }
    }

    if (inst instanceof Players) {
      if (key === "GetPlayers") {
        return nativeFn("GetPlayers", (a) => [
          LuaTable.fromArray(
            (InstanceBridge.unwrap(a[0]) as Players)
              .GetPlayers()
              .map((p) => this.wrapInstance(p)),
          ),
        ]);
      }
      if (key === "GetPlayerFromCharacter") {
        return nativeFn("GetPlayerFromCharacter", (a) => {
          const character = a[1] === undefined ? null : this.asInstance(a[1], "GetPlayerFromCharacter");
          const found = (InstanceBridge.unwrap(a[0]) as Players).GetPlayerFromCharacter(character);
          return [found ? this.wrapInstance(found) : undefined];
        });
      }
      if (key === "CreateHumanoidModelFromDescription") {
        return nativeFn("CreateHumanoidModelFromDescription", (a) => {
          const description = this.asInstance(a[1], "CreateHumanoidModelFromDescription");
          if (description.className !== "HumanoidDescription") {
            throw new LuaError("CreateHumanoidModelFromDescription expects a HumanoidDescription");
          }
          const model = buildAvatar(fromDescriptionInstance(description as HumanoidDescription));
          return [this.wrapInstance(model)];
        });
      }
      if (key === "GetHumanoidDescriptionFromCharacter") {
        return nativeFn("GetHumanoidDescriptionFromCharacter", (a) => {
          const character = this.asInstance(a[1], "GetHumanoidDescriptionFromCharacter");
          const instance = toDescriptionInstance(describeAvatar(character as Model));
          return [this.wrapInstance(instance)];
        });
      }
      if (key === "GetPlayerByUserId") {
        return nativeFn("GetPlayerByUserId", (a) => {
          const found = (InstanceBridge.unwrap(a[0]) as Players).GetPlayerByUserId(Number(a[1]) || 0);
          return [found ? this.wrapInstance(found) : undefined];
        });
      }
    }

    if (inst instanceof Player) {
      if (key === "Kick") {
        return nativeFn("Kick", (a) => {
          (InstanceBridge.unwrap(a[0]) as Player).Kick(a[1] === undefined ? "" : String(a[1]));
          return [];
        });
      }
      if (key === "LoadCharacter") {
        return nativeFn("LoadCharacter", (a) => {
          (InstanceBridge.unwrap(a[0]) as Player).LoadCharacter();
          return [];
        });
      }
    }

    if (inst instanceof RemoteEvent) {
      if (key === "FireClient") {
        if (this.ctx.side !== "server") {
          return nativeFn("FireClient", () => {
            throw new LuaError("FireClient can only be called from the server");
          });
        }
        return nativeFn("FireClient", (a) => {
          const remote = InstanceBridge.unwrap(a[0]) as RemoteEvent;
          remote.FireClient(
            this.asInstance(a[1], "FireClient"),
            ...a.slice(2).map((v) => this.toEngine(v)),
          );
          return [];
        });
      }
      if (key === "FireAllClients") {
        if (this.ctx.side !== "server") {
          return nativeFn("FireAllClients", () => {
            throw new LuaError("FireAllClients can only be called from the server");
          });
        }
        return nativeFn("FireAllClients", (a) => {
          const remote = InstanceBridge.unwrap(a[0]) as RemoteEvent;
          remote.FireAllClients(...a.slice(1).map((v) => this.toEngine(v)));
          return [];
        });
      }
      if (key === "FireServer") {
        if (this.ctx.side !== "client") {
          return nativeFn("FireServer", () => {
            throw new LuaError("FireServer can only be called from a client");
          });
        }
        return nativeFn("FireServer", (a) => {
          const remote = InstanceBridge.unwrap(a[0]) as RemoteEvent;
          remote.FireServer(...a.slice(1).map((v) => this.toEngine(v)));
          return [];
        });
      }
    }

    if (inst instanceof RemoteFunction) {
      const bridge = this;
      if (key === "InvokeServer" && this.ctx.side === "client") {
        return yieldingFn("InvokeServer", function* (a) {
          const remote = InstanceBridge.unwrap(a[0]) as RemoteFunction;
          const resumed = yield {
            kind: "waitPromise",
            promise: remote
              .InvokeServer(...a.slice(1).map((v) => bridge.toEngine(v)))
              .then((value) => [bridge.toLua(value)]),
          };
          return resumed ?? [];
        });
      }
      if (key === "InvokeClient" && this.ctx.side === "server") {
        return yieldingFn("InvokeClient", function* (a) {
          const remote = InstanceBridge.unwrap(a[0]) as RemoteFunction;
          const player = bridge.asInstance(a[1], "InvokeClient");
          const resumed = yield {
            kind: "waitPromise",
            promise: remote
              .InvokeClient(player, ...a.slice(2).map((v) => bridge.toEngine(v)))
              .then((value) => [bridge.toLua(value)]),
          };
          return resumed ?? [];
        });
      }
    }

    if (inst instanceof BindableEvent && key === "Fire") {
      return nativeFn("Fire", (a) => {
        (InstanceBridge.unwrap(a[0]) as BindableEvent).Fire(
          ...a.slice(1).map((v) => this.toEngine(v)),
        );
        return [];
      });
    }

    return undefined;
  }

  /** `Instance.new(className, parent)`. */
  instanceLibrary(): LuaTable {
    const lib = new LuaTable();
    lib.set(
      "new",
      nativeFn("Instance.new", (args) => {
        const className = String(args[0]);
        if (!isRegisteredClass(className)) {
          throw new LuaError(`Unable to create an Instance of type "${className}"`);
        }
        const parent = args[1] === undefined ? undefined : this.asInstance(args[1], "Instance.new");
        const inst = createInstance(className, parent);
        return [this.wrapInstance(inst)];
      }),
    );
    lib.frozen = true;
    return lib;
  }
}

export { wrapValue };
