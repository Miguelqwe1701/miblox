import {
  BaseScript,
  DataModel,
  Instance as EngineInstance,
  Material,
  TextXAlignment,
  TextYAlignment,
  PhysicsWorld,
  KeyCode,
  HumanoidStateType,
  PartShape,
  UserInputType,
  MATERIAL_BY_ID,
} from "@miblox/core";
import {
  LuaError,
  LuaTable,
  LuauVM,
  Scope,
  nativeFn,
  yieldingFn,
  type LuaFunction,
  type LuaValue,
} from "@miblox/luau";
import { InstanceBridge, type BridgeContext } from "./instances.js";
import { installDatatypes } from "./datatypes.js";

export interface ScriptEnvironmentOptions {
  game: DataModel;
  physics: PhysicsWorld;
  side: "server" | "client";
  /** Wall-clock budget per scheduler step. */
  budgetMs?: number;
  maxSteps?: number;
  onPrint?: (text: string, source: string) => void;
  onError?: (message: string, source: string) => void;
}

/**
 * A Luau VM with the MiBlox API installed: `game`, `workspace`, `Instance.new`,
 * the value types, `Enum`, and `require`.
 *
 * The server and each client build one of these. They differ only in `side`,
 * which gates members like `FireClient` that only make sense on one end.
 */
export class ScriptEnvironment {
  readonly vm: LuauVM;
  readonly bridge: InstanceBridge;
  private readonly moduleResults = new Map<EngineInstance, LuaValue>();
  private readonly modulesLoading = new Set<EngineInstance>();

  constructor(private readonly opts: ScriptEnvironmentOptions) {
    this.vm = new LuauVM({
      budgetMs: opts.budgetMs ?? 100,
      maxSteps: opts.maxSteps ?? 2_000_000,
      onPrint: (text) => opts.onPrint?.(text, "print"),
      onWarn: (text) => opts.onPrint?.(text, "warn"),
      onError: (err, threadName) => {
        opts.onError?.(err.traceback ? `${err.message}\n${err.traceback}` : err.message, threadName);
      },
    });

    const ctx: BridgeContext = {
      game: opts.game,
      vm: this.vm,
      physics: opts.physics,
      side: opts.side,
    };
    this.bridge = new InstanceBridge(ctx);
    this.installGlobals();
  }

  private installGlobals(): void {
    const g = this.vm.globals;
    const game = this.opts.game;

    installDatatypes(g);
    g.set("Instance", this.bridge.instanceLibrary());
    g.set("game", this.bridge.wrapInstance(game));
    g.set("workspace", this.bridge.wrapInstance(game.Workspace));
    g.set("Workspace", g.get("workspace"));
    g.set("Enum", buildEnumTable());
    g.set("require", this.buildRequire());

    // Roblox exposes these two on the client; harmless and handy on both.
    g.set(
      "UserSettings",
      nativeFn("UserSettings", () => [new LuaTable()]),
    );
  }

  /** Compiles a script with `script` bound to its own instance. */
  compileScript(script: BaseScript): LuaFunction {
    const scope = new Scope(null, []);
    scope.declare("script", this.bridge.wrapInstance(script));
    return this.vm.interp.load(script.Source, script.GetFullName(), scope);
  }

  /**
   * Compiles and queues a script to run on its own thread.
   *
   * Destroying the script stops that thread, as in Roblox, so a GUI that is
   * replaced on respawn does not leave its old script's loop running beside
   * the new one.
   */
  runScript(script: BaseScript): void {
    let fn: LuaFunction;
    try {
      fn = this.compileScript(script);
    } catch (err) {
      this.opts.onError?.(String((err as Error).message ?? err), script.GetFullName());
      return;
    }
    const thread = this.vm.scheduler.spawn(fn, []);
    const conn = script.Destroying.Connect(() => {
      conn.Disconnect();
      this.vm.scheduler.cancel(thread);
    });
  }

  /**
   * `require(moduleScript)`.
   *
   * Each module runs at most once and its result is cached, so two scripts
   * requiring the same module share state, exactly as Roblox does. Cycles are
   * detected rather than recursing until the stack gives out.
   */
  private buildRequire(): LuaFunction {
    const env = this;
    return yieldingFn("require", function* (args) {
      const target = env.bridge.asInstance(args[0], "require");
      if (target.className !== "ModuleScript") {
        throw new LuaError(`Attempted to require a ${target.className}, which is not a ModuleScript`);
      }
      if (env.moduleResults.has(target)) return [env.moduleResults.get(target)];
      if (env.modulesLoading.has(target)) {
        throw new LuaError(`Requested module "${target.GetFullName()}" requires itself`);
      }

      env.modulesLoading.add(target);
      try {
        const fn = env.compileScript(target as BaseScript);
        const results = yield* env.vm.interp.call(fn, []);
        const value = results[0];
        if (value === undefined) {
          throw new LuaError(`Module "${target.GetFullName()}" did not return a value`);
        }
        env.moduleResults.set(target, value);
        return [value];
      } finally {
        env.modulesLoading.delete(target);
      }
    });
  }

  /** Drops a module's cached result, so a hot-reloaded module runs again. */
  invalidateModule(module: EngineInstance): void {
    this.moduleResults.delete(module);
  }

  step(dt: number): void {
    this.vm.step(dt);
  }
}

/** Enum values are plain strings, so `part.Material = Enum.Material.Grass` just works. */
function buildEnumTable(): LuaTable {
  const root = new LuaTable();

  const addEnum = (name: string, values: readonly string[]): void => {
    const table = new LuaTable();
    for (const value of values) table.set(value, value);
    table.frozen = true;
    root.set(name, table);
  };

  addEnum("Material", Object.keys(Material));
  addEnum("PartType", Object.keys(PartShape));
  addEnum("HumanoidStateType", Object.keys(HumanoidStateType));
  addEnum("KeyCode", Object.keys(KeyCode));
  addEnum("UserInputType", Object.keys(UserInputType));
  addEnum("UserInputState", ["Begin", "Change", "End"]);
  addEnum("TextXAlignment", Object.keys(TextXAlignment));
  addEnum("TextYAlignment", Object.keys(TextYAlignment));
  addEnum("RunContext", ["Server", "Client", "Legacy"]);
  addEnum("CameraType", ["Custom", "Scriptable", "Follow", "Attach", "Fixed"]);
  addEnum("CameraMode", ["Classic", "LockFirstPerson"]);
  addEnum("RaycastFilterType", ["Exclude", "Include"]);
  addEnum("NormalId", ["Top", "Bottom", "Left", "Right", "Front", "Back"]);
  addEnum("AccessoryType", [
    "Hat",
    "Hair",
    "Face",
    "Neck",
    "Shoulder",
    "Front",
    "Back",
    "Waist",
  ]);
  addEnum("AssetType", ["Shirt", "Pants", "TShirt", "Hat", "Hair", "Face", "Mesh"]);
  addEnum("BodyPart", ["Head", "Torso", "LeftArm", "RightArm", "LeftLeg", "RightLeg"]);
  // Terrain materials, indexed by voxel id. Air is included on purpose: it is
  // how a script clears a region, which is the only way to carve out a space
  // in procedurally generated ground.
  addEnum("TerrainMaterial", MATERIAL_BY_ID);

  root.frozen = true;
  return root;
}
