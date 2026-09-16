import { CFrame, Color3, Vector3 } from "./math.js";
import { Instance, registerClass, type PropSchema } from "./instance.js";
import { Signal } from "./signal.js";
import { materialProps } from "./enums.js";
import { VoxelWorld } from "./terrain-data.js";

/** Convenience for schema entries that replicate by default. */
const p = (kind: PropSchema[string]["kind"], def: unknown, extra: Partial<PropSchema[string]> = {}) =>
  ({ kind, default: def, replicated: true, ...extra }) as PropSchema[string];

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

export class Folder extends Instance {
  readonly className = "Folder";
}
registerClass("Folder", Folder, {});

export class Configuration extends Instance {
  readonly className = "Configuration";
}
registerClass("Configuration", Configuration, {});

/** Named value objects, the usual way scripts stash shared state. */
export interface ValueInstance extends Instance {
  Value: unknown;
}

function makeValueClass(
  className: string,
  kind: PropSchema[string]["kind"],
  def: unknown,
): new () => ValueInstance {
  const cls = class extends Instance {
    readonly className = className;
    Value: unknown = def;
  };
  Object.defineProperty(cls, "name", { value: className });
  registerClass(className, cls as unknown as new () => Instance, { Value: p(kind, def) });
  return cls as unknown as new () => ValueInstance;
}

export const IntValue = makeValueClass("IntValue", "number", 0);
export const NumberValue = makeValueClass("NumberValue", "number", 0);
export const StringValue = makeValueClass("StringValue", "string", "");
export const BoolValue = makeValueClass("BoolValue", "boolean", false);
export const Vector3Value = makeValueClass("Vector3Value", "Vector3", Vector3.zero);
export const CFrameValue = makeValueClass("CFrameValue", "CFrame", CFrame.identity);
export const Color3Value = makeValueClass("Color3Value", "Color3", new Color3(1, 1, 1));
export const ObjectValue = makeValueClass("ObjectValue", "ref", null);

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

export class BasePart extends Instance {
  readonly className: string = "BasePart";

  CFrame: CFrame = CFrame.identity;
  Size: Vector3 = new Vector3(4, 1, 2);
  Color: Color3 = new Color3(0.64, 0.64, 0.65);
  Material = "Plastic";
  Transparency = 0;
  Reflectance = 0;
  Anchored = false;
  CanCollide = true;
  CanTouch = true;
  CanQuery = true;
  Massless = false;
  Shape = "Block";
  /** Image URL drawn over this part. Shirts and pants are just this. */
  TextureId = "";
  CustomPhysicalProperties: { density?: number; friction?: number; elasticity?: number } | null = null;

  /** Linear/angular velocity live on the part so physics stays data-driven. */
  AssemblyLinearVelocity: Vector3 = Vector3.zero;
  AssemblyAngularVelocity: Vector3 = Vector3.zero;

  /**
   * Which client simulates this part. Empty means the server does.
   *
   * Handing a player ownership of their own character removes a round trip
   * from every input, which is what makes movement feel responsive over a real
   * connection. The cost is that the owner is trusted about that part, so a
   * place that cares sets ServerAuthoritative and keeps ownership server-side.
   */
  NetworkOwnerId = "";

  readonly Touched = new Signal<[BasePart]>();
  readonly TouchEnded = new Signal<[BasePart]>();

  protected override ancestryClassNames(): string[] {
    return ["BasePart", "PVInstance", "Instance"];
  }

  get Position(): Vector3 {
    return this.CFrame.position;
  }
  set Position(v: Vector3) {
    this.setProperty("CFrame", new CFrame(
      v,
      this.CFrame.r00, this.CFrame.r01, this.CFrame.r02,
      this.CFrame.r10, this.CFrame.r11, this.CFrame.r12,
      this.CFrame.r20, this.CFrame.r21, this.CFrame.r22,
    ));
  }

  get Orientation(): Vector3 {
    const [x, y, z] = this.CFrame.toEulerAnglesXYZ();
    const d = 180 / Math.PI;
    return new Vector3(x * d, y * d, z * d);
  }

  get density(): number {
    return this.CustomPhysicalProperties?.density ?? materialProps(this.Material).density;
  }

  get friction(): number {
    return this.CustomPhysicalProperties?.friction ?? materialProps(this.Material).friction;
  }

  get elasticity(): number {
    return this.CustomPhysicalProperties?.elasticity ?? materialProps(this.Material).elasticity;
  }

  GetMass(): number {
    if (this.Massless) return 0;
    return this.Size.x * this.Size.y * this.Size.z * this.density;
  }

  /** World-space AABB, accounting for rotation. */
  getBoundingBox(): { min: Vector3; max: Vector3 } {
    const h = this.Size.mul(0.5);
    const c = this.CFrame;
    const ex =
      Math.abs(c.r00) * h.x + Math.abs(c.r01) * h.y + Math.abs(c.r02) * h.z;
    const ey =
      Math.abs(c.r10) * h.x + Math.abs(c.r11) * h.y + Math.abs(c.r12) * h.z;
    const ez =
      Math.abs(c.r20) * h.x + Math.abs(c.r21) * h.y + Math.abs(c.r22) * h.z;
    const e = new Vector3(ex, ey, ez);
    return { min: c.position.sub(e), max: c.position.add(e) };
  }
}

const basePartSchema: PropSchema = {
  CFrame: p("CFrame", CFrame.identity),
  Size: p("Vector3", new Vector3(4, 1, 2)),
  Color: p("Color3", new Color3(0.64, 0.64, 0.65)),
  Material: p("string", "Plastic"),
  Transparency: p("number", 0),
  Reflectance: p("number", 0),
  Anchored: p("boolean", false),
  CanCollide: p("boolean", true),
  CanTouch: p("boolean", true),
  CanQuery: p("boolean", true),
  Massless: p("boolean", false),
  Shape: p("string", "Block"),
  TextureId: p("string", ""),
  AssemblyLinearVelocity: p("Vector3", Vector3.zero),
  AssemblyAngularVelocity: p("Vector3", Vector3.zero),
  NetworkOwnerId: p("string", ""),
};

export class Part extends BasePart {
  override readonly className = "Part";
  protected override ancestryClassNames(): string[] {
    return ["Part", "BasePart", "PVInstance", "Instance"];
  }
}
registerClass("Part", Part, basePartSchema);

export class WedgePart extends BasePart {
  override readonly className = "WedgePart";
  protected override ancestryClassNames(): string[] {
    return ["WedgePart", "BasePart", "PVInstance", "Instance"];
  }
}
registerClass("WedgePart", WedgePart, basePartSchema);

export class SpawnLocation extends BasePart {
  override readonly className = "SpawnLocation";
  Neutral = true;
  Duration = 0;
  protected override ancestryClassNames(): string[] {
    return ["SpawnLocation", "BasePart", "PVInstance", "Instance"];
  }
}
registerClass("SpawnLocation", SpawnLocation, {
  ...basePartSchema,
  Neutral: p("boolean", true),
  Duration: p("number", 0),
});

/**
 * A part drawn as a mesh rather than a primitive.
 *
 * `MeshId` is either `builtin:<name>` for one of the shapes the renderer can
 * generate itself, or a URL to a glTF/GLB file. Keeping both behind one
 * property means a place can start with built-ins and move to real assets
 * without changing anything that refers to the part.
 */
export class MeshPart extends BasePart {
  override readonly className: string = "MeshPart";
  MeshId = "";
  MeshScale: Vector3 = Vector3.one;
  protected override ancestryClassNames(): string[] {
    return ["MeshPart", "BasePart", "PVInstance", "Instance"];
  }
}
const meshPartSchema: PropSchema = {
  ...basePartSchema,
  MeshId: p("string", ""),
  MeshScale: p("Vector3", Vector3.one),
};
registerClass("MeshPart", MeshPart, meshPartSchema);

/**
 * The same part under the name the editor's import flow uses.
 *
 * Registered as its own class rather than an alias so a place file that says
 * Mesh3D loads back as Mesh3D, and IsA("MeshPart") still answers true.
 */
export class Mesh3D extends MeshPart {
  override readonly className = "Mesh3D";
  protected override ancestryClassNames(): string[] {
    return ["Mesh3D", "MeshPart", "BasePart", "PVInstance", "Instance"];
  }
}
registerClass("Mesh3D", Mesh3D, meshPartSchema);

export class Model extends Instance {
  readonly className = "Model";
  PrimaryPart: BasePart | null = null;

  protected override ancestryClassNames(): string[] {
    return ["Model", "PVInstance", "Instance"];
  }

  GetPrimaryPartCFrame(): CFrame {
    return this.PrimaryPart?.CFrame ?? CFrame.identity;
  }

  /** Moves the whole model, preserving each part's offset from the primary. */
  SetPrimaryPartCFrame(cf: CFrame): void {
    const primary = this.PrimaryPart;
    if (!primary) return;
    const inverse = primary.CFrame.inverse();
    for (const desc of this.GetDescendants()) {
      if (!(desc instanceof BasePart)) continue;
      desc.setProperty("CFrame", cf.mul(inverse.mul(desc.CFrame)));
    }
  }

  MoveTo(position: Vector3): void {
    const primary = this.PrimaryPart ?? (this.FindFirstChildOfClass("Part") as BasePart | null);
    if (!primary) return;
    const delta = position.sub(primary.CFrame.position);
    for (const desc of this.GetDescendants()) {
      if (desc instanceof BasePart) desc.setProperty("CFrame", desc.CFrame.add(delta));
    }
  }

  GetBoundingBox(): { min: Vector3; max: Vector3; center: Vector3; size: Vector3 } {
    let min = new Vector3(Infinity, Infinity, Infinity);
    let max = new Vector3(-Infinity, -Infinity, -Infinity);
    for (const desc of this.GetDescendants()) {
      if (!(desc instanceof BasePart)) continue;
      const bb = desc.getBoundingBox();
      min = new Vector3(
        Math.min(min.x, bb.min.x),
        Math.min(min.y, bb.min.y),
        Math.min(min.z, bb.min.z),
      );
      max = new Vector3(
        Math.max(max.x, bb.max.x),
        Math.max(max.y, bb.max.y),
        Math.max(max.z, bb.max.z),
      );
    }
    if (!Number.isFinite(min.x)) {
      min = Vector3.zero;
      max = Vector3.zero;
    }
    return { min, max, center: min.add(max).mul(0.5), size: max.sub(min) };
  }
}
registerClass("Model", Model, { PrimaryPart: { kind: "ref", default: null, replicated: true } });

// ---------------------------------------------------------------------------
// Characters
// ---------------------------------------------------------------------------

export class Humanoid extends Instance {
  readonly className = "Humanoid";
  Health = 100;
  MaxHealth = 100;
  WalkSpeed = 16;
  JumpPower = 50;
  HipHeight = 0;
  AutoRotate = true;
  PlatformStand = false;
  Sit = false;
  MoveDirection: Vector3 = Vector3.zero;
  /** Set by the controller each step; the physics solver consumes it. */
  Jump = false;
  state = "Running";

  readonly Died = new Signal<[]>();
  readonly HealthChanged = new Signal<[number]>();
  readonly StateChanged = new Signal<[string, string]>();
  readonly Touched = new Signal<[BasePart]>();

  TakeDamage(amount: number): void {
    if (this.Health <= 0) return;
    this.setProperty("Health", Math.max(0, this.Health - amount));
    this.HealthChanged.Fire(this.Health);
    if (this.Health <= 0) {
      this.changeState("Dead");
      this.Died.Fire();
    }
  }

  changeState(next: string): void {
    if (this.state === next) return;
    const prev = this.state;
    this.setProperty("state", next);
    this.StateChanged.Fire(prev, next);
  }

  Move(direction: Vector3, relativeToCamera = false): void {
    void relativeToCamera;
    this.setProperty("MoveDirection", direction.magnitude > 1 ? direction.unit : direction);
  }

  /**
   * Bound by the avatar module.
   *
   * Applying a description means rebuilding clothing and accessories, which
   * needs the asset catalogue; wiring it in here rather than importing it
   * keeps classes.ts free of a dependency on it.
   */
  applyDescriptionHandler?: (description: HumanoidDescription) => void;

  ApplyDescription(description: HumanoidDescription): void {
    this.applyDescriptionHandler?.(description);
  }

  describeHandler?: () => HumanoidDescription;

  GetAppliedDescription(): HumanoidDescription | undefined {
    return this.describeHandler?.();
  }
}
registerClass("Humanoid", Humanoid, {
  Health: p("number", 100),
  MaxHealth: p("number", 100),
  WalkSpeed: p("number", 16),
  JumpPower: p("number", 50),
  HipHeight: p("number", 0),
  AutoRotate: p("boolean", true),
  PlatformStand: p("boolean", false),
  Sit: p("boolean", false),
  MoveDirection: p("Vector3", Vector3.zero),
  state: p("string", "Running"),
});

/**
 * A hat or other worn item.
 *
 * Contains a part named "Handle"; the rig positions that handle at the named
 * attachment point, offset by `AttachmentOffset`. This is the same shape
 * Roblox uses, so accessories built for one work in the other.
 */
export class Accessory extends Instance {
  readonly className = "Accessory";
  AttachmentPoint = "Hat";
  AttachmentOffset: Vector3 = Vector3.zero;
  /** Hat, Hair, Face, Neck, Shoulder, Front, Back or Waist. */
  AccessoryType = "Hat";
  /** Catalogue id this came from, so a description can be read back out. */
  AssetId = 0;
}
registerClass("Accessory", Accessory, {
  AttachmentPoint: p("string", "Hat"),
  AttachmentOffset: p("Vector3", Vector3.zero),
  AccessoryType: p("string", "Hat"),
  AssetId: p("number", 0),
});

/** Clothing. The template is an image URL applied to the torso and limbs. */
export class Shirt extends Instance {
  readonly className = "Shirt";
  ShirtTemplate = "";
  /** Catalogue id this was built from, or 0 when set from a raw URL. */
  AssetId = 0;
}
registerClass("Shirt", Shirt, { ShirtTemplate: p("string", ""), AssetId: p("number", 0) });

export class Pants extends Instance {
  readonly className = "Pants";
  PantsTemplate = "";
  AssetId = 0;
}
registerClass("Pants", Pants, { PantsTemplate: p("string", ""), AssetId: p("number", 0) });

/** A graphic printed on the front of the torso. */
export class ShirtGraphic extends Instance {
  readonly className = "ShirtGraphic";
  Graphic = "";
  AssetId = 0;
}
registerClass("ShirtGraphic", ShirtGraphic, { Graphic: p("string", ""), AssetId: p("number", 0) });

/**
 * A complete description of how a character looks.
 *
 * Every wearable is a catalogue id, so this is a couple of dozen numbers: it
 * stores on an account in a few hundred bytes, replicates as ordinary
 * property state, and can be applied to any rig with a Humanoid.
 *
 * Mirrors Roblox's HumanoidDescription, including its convention that
 * accessory fields hold comma-separated id lists so a character can wear
 * several of the same kind.
 */
export class HumanoidDescription extends Instance {
  readonly className = "HumanoidDescription";

  // Body colours
  HeadColor: Color3 = Color3.fromHex(0xf3d9a4);
  TorsoColor: Color3 = Color3.fromHex(0x3b6ea5);
  LeftArmColor: Color3 = Color3.fromHex(0xf3d9a4);
  RightArmColor: Color3 = Color3.fromHex(0xf3d9a4);
  LeftLegColor: Color3 = Color3.fromHex(0x2e4a63);
  RightLegColor: Color3 = Color3.fromHex(0x2e4a63);

  // Clothing, by catalogue id. 0 means nothing in that slot.
  Shirt = 0;
  Pants = 0;
  GraphicTShirt = 0;
  Face = 0;

  // Accessories, as comma-separated id lists.
  HatAccessory = "";
  HairAccessory = "";
  FaceAccessory = "";
  NeckAccessory = "";
  ShouldersAccessory = "";
  FrontAccessory = "";
  BackAccessory = "";
  WaistAccessory = "";

  // Scale
  HeightScale = 1;
  WidthScale = 1;
  HeadScale = 1;
  BodyTypeScale = 0;
  ProportionScale = 0;

  // Humanoid settings carried along with the look, as Roblox does.
  WalkSpeed = 16;
  JumpPower = 50;
  MaxHealth = 100;
  DisplayName = "";
}
registerClass("HumanoidDescription", HumanoidDescription, {
  HeadColor: p("Color3", Color3.fromHex(0xf3d9a4)),
  TorsoColor: p("Color3", Color3.fromHex(0x3b6ea5)),
  LeftArmColor: p("Color3", Color3.fromHex(0xf3d9a4)),
  RightArmColor: p("Color3", Color3.fromHex(0xf3d9a4)),
  LeftLegColor: p("Color3", Color3.fromHex(0x2e4a63)),
  RightLegColor: p("Color3", Color3.fromHex(0x2e4a63)),
  Shirt: p("number", 0),
  Pants: p("number", 0),
  GraphicTShirt: p("number", 0),
  Face: p("number", 0),
  HatAccessory: p("string", ""),
  HairAccessory: p("string", ""),
  FaceAccessory: p("string", ""),
  NeckAccessory: p("string", ""),
  ShouldersAccessory: p("string", ""),
  FrontAccessory: p("string", ""),
  BackAccessory: p("string", ""),
  WaistAccessory: p("string", ""),
  HeightScale: p("number", 1),
  WidthScale: p("number", 1),
  HeadScale: p("number", 1),
  BodyTypeScale: p("number", 0),
  ProportionScale: p("number", 0),
  WalkSpeed: p("number", 16),
  JumpPower: p("number", 50),
  MaxHealth: p("number", 100),
  DisplayName: p("string", ""),
});

/** Per-limb skin colour, so a rig does not have to bake it into each part. */
export class BodyColors extends Instance {
  readonly className = "BodyColors";
  HeadColor: Color3 = Color3.fromHex(0xf3d9a4);
  TorsoColor: Color3 = Color3.fromHex(0x3b6ea5);
  LeftArmColor: Color3 = Color3.fromHex(0xf3d9a4);
  RightArmColor: Color3 = Color3.fromHex(0xf3d9a4);
  LeftLegColor: Color3 = Color3.fromHex(0x2e4a63);
  RightLegColor: Color3 = Color3.fromHex(0x2e4a63);
}
registerClass("BodyColors", BodyColors, {
  HeadColor: p("Color3", Color3.fromHex(0xf3d9a4)),
  TorsoColor: p("Color3", Color3.fromHex(0x3b6ea5)),
  LeftArmColor: p("Color3", Color3.fromHex(0xf3d9a4)),
  RightArmColor: p("Color3", Color3.fromHex(0xf3d9a4)),
  LeftLegColor: p("Color3", Color3.fromHex(0x2e4a63)),
  RightLegColor: p("Color3", Color3.fromHex(0x2e4a63)),
});

// ---------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------

export class BaseScript extends Instance {
  readonly className: string = "BaseScript";
  Source = "";
  Enabled = true;
  RunContext = "Legacy";

  protected override ancestryClassNames(): string[] {
    return ["BaseScript", "LuaSourceContainer", "Instance"];
  }
}

/** Source is deliberately not replicated: clients never receive server code. */
const scriptSchema: PropSchema = {
  Source: { kind: "string", default: "", replicated: false },
  Enabled: p("boolean", true),
  RunContext: p("string", "Legacy"),
};

export class Script extends BaseScript {
  override readonly className = "Script";
  protected override ancestryClassNames(): string[] {
    return ["Script", "BaseScript", "LuaSourceContainer", "Instance"];
  }
}
registerClass("Script", Script, scriptSchema);

export class LocalScript extends BaseScript {
  override readonly className = "LocalScript";
  protected override ancestryClassNames(): string[] {
    return ["LocalScript", "BaseScript", "LuaSourceContainer", "Instance"];
  }
}
// LocalScript source must reach the client, unlike server Script source.
registerClass("LocalScript", LocalScript, {
  ...scriptSchema,
  Source: { kind: "string", default: "", replicated: true },
});

export class ModuleScript extends BaseScript {
  override readonly className = "ModuleScript";
  protected override ancestryClassNames(): string[] {
    return ["ModuleScript", "LuaSourceContainer", "Instance"];
  }
}
registerClass("ModuleScript", ModuleScript, {
  ...scriptSchema,
  Source: { kind: "string", default: "", replicated: true },
});

// ---------------------------------------------------------------------------
// Remote events / functions
// ---------------------------------------------------------------------------

export class RemoteEvent extends Instance {
  readonly className = "RemoteEvent";
  /** Server side: (player, ...args). */
  readonly OnServerEvent = new Signal<[Instance, ...unknown[]]>();
  /** Client side: (...args). */
  readonly OnClientEvent = new Signal<unknown[]>();

  /** Bound by the runtime; unbound in tests, where firing is a no-op. */
  transport: {
    fireClient?(player: Instance, args: unknown[]): void;
    fireAllClients?(args: unknown[]): void;
    fireServer?(args: unknown[]): void;
  } = {};

  FireClient(player: Instance, ...args: unknown[]): void {
    this.transport.fireClient?.(player, args);
  }
  FireAllClients(...args: unknown[]): void {
    this.transport.fireAllClients?.(args);
  }
  FireServer(...args: unknown[]): void {
    this.transport.fireServer?.(args);
  }
}
registerClass("RemoteEvent", RemoteEvent, {});

export class RemoteFunction extends Instance {
  readonly className = "RemoteFunction";
  OnServerInvoke: ((player: Instance, ...args: unknown[]) => unknown) | null = null;
  OnClientInvoke: ((...args: unknown[]) => unknown) | null = null;
  transport: {
    invokeServer?(args: unknown[]): Promise<unknown>;
    invokeClient?(player: Instance, args: unknown[]): Promise<unknown>;
  } = {};

  InvokeServer(...args: unknown[]): Promise<unknown> {
    return this.transport.invokeServer?.(args) ?? Promise.resolve(undefined);
  }
  InvokeClient(player: Instance, ...args: unknown[]): Promise<unknown> {
    return this.transport.invokeClient?.(player, args) ?? Promise.resolve(undefined);
  }
}
registerClass("RemoteFunction", RemoteFunction, {});

export class BindableEvent extends Instance {
  readonly className = "BindableEvent";
  readonly Event = new Signal<unknown[]>();
  Fire(...args: unknown[]): void {
    this.Event.Fire(...args);
  }
}
registerClass("BindableEvent", BindableEvent, {});

// ---------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------

export class Terrain extends Instance {
  readonly className = "Terrain";
  readonly voxels = new VoxelWorld();
  WaterColor: Color3 = Color3.fromHex(0x2a6fa8);
  WaterTransparency = 0.6;

  /** Emitted for every voxel edit so the server can replicate chunk deltas. */
  readonly Changed3D = new Signal<[number, number, number]>();

  FillBlock(min: Vector3, max: Vector3, materialId: number): number {
    return this.voxels.fillBlock(min, max, materialId);
  }
  FillBall(center: Vector3, radius: number, materialId: number): number {
    return this.voxels.fillBall(center, radius, materialId);
  }
  SetVoxel(vx: number, vy: number, vz: number, materialId: number): boolean {
    const changed = this.voxels.setVoxel(vx, vy, vz, materialId);
    if (changed) this.Changed3D.Fire(vx, vy, vz);
    return changed;
  }
  GetVoxel(vx: number, vy: number, vz: number): number {
    return this.voxels.getVoxel(vx, vy, vz);
  }
}
registerClass("Terrain", Terrain, {
  WaterColor: p("Color3", Color3.fromHex(0x2a6fa8)),
  WaterTransparency: p("number", 0.6),
});

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

export class Workspace extends Instance {
  readonly className = "Workspace";
  Gravity = 196.2;
  FallenPartsDestroyHeight = -500;
  CurrentCamera: Instance | null = null;
  Terrain: Terrain = null as unknown as Terrain;

  protected override ancestryClassNames(): string[] {
    return ["Workspace", "Model", "Instance"];
  }
}
registerClass("Workspace", Workspace, {
  Gravity: p("number", 196.2),
  FallenPartsDestroyHeight: p("number", -500),
});

export class Lighting extends Instance {
  readonly className = "Lighting";
  ClockTime = 14;
  Ambient: Color3 = Color3.fromHex(0x545454);
  OutdoorAmbient: Color3 = Color3.fromHex(0x7a7a7a);
  Brightness = 2;
  FogStart = 400;
  FogEnd = 3000;
  FogColor: Color3 = Color3.fromHex(0xc8d4e0);
  GeographicLatitude = 41.7;

  /** Sun direction derived from ClockTime; noon is straight overhead. */
  getSunDirection(): Vector3 {
    const angle = ((this.ClockTime - 6) / 12) * Math.PI;
    return new Vector3(Math.cos(angle), Math.sin(angle), 0.35).unit;
  }
}
registerClass("Lighting", Lighting, {
  ClockTime: p("number", 14),
  Ambient: p("Color3", Color3.fromHex(0x545454)),
  OutdoorAmbient: p("Color3", Color3.fromHex(0x7a7a7a)),
  Brightness: p("number", 2),
  FogStart: p("number", 400),
  FogEnd: p("number", 3000),
  FogColor: p("Color3", Color3.fromHex(0xc8d4e0)),
  GeographicLatitude: p("number", 41.7),
});

class ServiceFolder extends Instance {
  readonly className: string = "ServiceFolder";
}

function registerService(className: string): new () => Instance {
  const cls = class extends ServiceFolder {
    override readonly className = className;
  };
  Object.defineProperty(cls, "name", { value: className });
  registerClass(className, cls as unknown as new () => Instance, {});
  return cls as unknown as new () => Instance;
}

export const ReplicatedStorage = registerService("ReplicatedStorage");
export const ReplicatedFirst = registerService("ReplicatedFirst");
export const ServerStorage = registerService("ServerStorage");
export const ServerScriptService = registerService("ServerScriptService");
export const StarterPlayer = registerService("StarterPlayer");
export const StarterPlayerScripts = registerService("StarterPlayerScripts");
export const StarterCharacterScripts = registerService("StarterCharacterScripts");
export const StarterGui = registerService("StarterGui");
export const StarterPack = registerService("StarterPack");
export const SoundService = registerService("SoundService");
export const TeleportService = registerService("TeleportService");
export const Teams = registerService("Teams");

export class Players extends Instance {
  readonly className = "Players";
  MaxPlayers = 32;
  RespawnTime = 5;
  CharacterAutoLoads = true;
  LocalPlayer: Player | null = null;

  readonly PlayerAdded = new Signal<[Player]>();
  readonly PlayerRemoving = new Signal<[Player]>();

  GetPlayers(): Player[] {
    return this.GetChildren().filter((c): c is Player => c instanceof Player);
  }

  GetPlayerByUserId(userId: number): Player | null {
    return this.GetPlayers().find((pl) => pl.UserId === userId) ?? null;
  }

  GetPlayerFromCharacter(character: Instance | null): Player | null {
    if (!character) return null;
    return this.GetPlayers().find((pl) => pl.Character === character) ?? null;
  }
}
registerClass("Players", Players, {
  MaxPlayers: p("number", 32),
  RespawnTime: p("number", 5),
  CharacterAutoLoads: p("boolean", true),
});

export class Player extends Instance {
  readonly className = "Player";
  UserId = 0;
  DisplayName = "";
  Character: Model | null = null;
  Team: string | null = null;
  CameraMode = "Classic";
  /** Platform reported by the client at join; informs control hints. */
  Platform = "Desktop";

  readonly CharacterAdded = new Signal<[Model]>();
  readonly CharacterRemoving = new Signal<[Model]>();
  readonly Chatted = new Signal<[string]>();

  Kick(reason = ""): void {
    this.kickHandler?.(reason);
  }
  /** Bound by the server; undefined on the client. */
  kickHandler?: (reason: string) => void;

  LoadCharacter(): void {
    this.loadCharacterHandler?.();
  }
  loadCharacterHandler?: () => void;
}
registerClass("Player", Player, {
  UserId: p("number", 0),
  DisplayName: p("string", ""),
  Character: { kind: "ref", default: null, replicated: true },
  Team: p("string", null),
  CameraMode: p("string", "Classic"),
  Platform: p("string", "Desktop"),
});

export class Camera extends Instance {
  readonly className = "Camera";
  CFrame: CFrame = CFrame.identity;
  FieldOfView = 70;
  CameraType = "Custom";
  CameraSubject: Instance | null = null;
  Focus: CFrame = CFrame.identity;
}
registerClass("Camera", Camera, {
  CFrame: { kind: "CFrame", default: CFrame.identity, replicated: false },
  FieldOfView: { kind: "number", default: 70, replicated: false },
  CameraType: { kind: "string", default: "Custom", replicated: false },
});

export class Attachment extends Instance {
  readonly className = "Attachment";
  CFrame: CFrame = CFrame.identity;
}
registerClass("Attachment", Attachment, { CFrame: p("CFrame", CFrame.identity) });

export class Motor6D extends Instance {
  readonly className = "Motor6D";
  Part0: BasePart | null = null;
  Part1: BasePart | null = null;
  C0: CFrame = CFrame.identity;
  C1: CFrame = CFrame.identity;
  Transform: CFrame = CFrame.identity;
}
registerClass("Motor6D", Motor6D, {
  Part0: { kind: "ref", default: null, replicated: true },
  Part1: { kind: "ref", default: null, replicated: true },
  C0: p("CFrame", CFrame.identity),
  C1: p("CFrame", CFrame.identity),
});
