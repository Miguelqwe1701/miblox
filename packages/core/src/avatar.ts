import { CFrame, Color3, Vector3 } from "./math.js";
import { createInstance, type Instance } from "./instance.js";
import {
  Accessory,
  BasePart,
  Humanoid,
  HumanoidDescription,
  MeshPart,
  Model,
  Pants,
  Shirt,
  ShirtGraphic,
} from "./classes.js";
import { RIG_LIMBS, buildCharacter, type CharacterOptions } from "./character.js";
import { getAsset, isCompatible, parseAssetList, type AssetInfo } from "./assets.js";

/**
 * How a character looks, as plain data.
 *
 * This is the storable form of a HumanoidDescription: a handful of numbers and
 * short strings, so one fits comfortably on an account row and travels as
 * ordinary JSON. The instance class and this interface carry the same fields
 * on purpose - `toDescriptionInstance` and `fromDescriptionInstance` convert
 * between them without a translation table.
 */
export interface HumanoidDescriptionData {
  headColor?: number;
  torsoColor?: number;
  leftArmColor?: number;
  rightArmColor?: number;
  leftLegColor?: number;
  rightLegColor?: number;

  /** Catalogue ids. 0 means nothing in that slot. */
  shirt?: number;
  pants?: number;
  graphicTShirt?: number;
  face?: number;

  /** Comma-separated id lists, as Roblox stores them. */
  hatAccessory?: string;
  hairAccessory?: string;
  faceAccessory?: string;
  neckAccessory?: string;
  shouldersAccessory?: string;
  frontAccessory?: string;
  backAccessory?: string;
  waistAccessory?: string;

  heightScale?: number;
  widthScale?: number;
  headScale?: number;

  walkSpeed?: number;
  jumpPower?: number;
  maxHealth?: number;
  displayName?: string;
}

export type AttachmentPoint =
  | "Hat"
  | "Hair"
  | "Head"
  | "Face"
  | "Neck"
  | "Shoulder"
  | "Front"
  | "Back"
  | "Waist"
  | "LeftHand"
  | "RightHand";

/** Where each attachment point sits, relative to the rig's root. */
export const ATTACHMENT_OFFSETS: Record<AttachmentPoint, Vector3> = {
  // The head spans y 1.0 to 2.0 above the root, so hair sits just on top of it
  // and the hat above that. Any lower and hair covers the face.
  Hat: new Vector3(0, 2.4, 0),
  Hair: new Vector3(0, 2.05, 0),
  Head: new Vector3(0, 1.5, 0),
  Face: new Vector3(0, 1.5, -0.55),
  Neck: new Vector3(0, 0.95, 0),
  Shoulder: new Vector3(0, 0.85, 0),
  Front: new Vector3(0, 0.2, -0.6),
  Back: new Vector3(0, 0.3, 0.6),
  Waist: new Vector3(0, -1.1, 0),
  LeftHand: new Vector3(-1.5, -0.9, 0),
  RightHand: new Vector3(1.5, -0.9, 0),
};

/** Which description field feeds each accessory slot. */
const ACCESSORY_SLOTS: Array<{
  field: keyof HumanoidDescriptionData;
  attachment: AttachmentPoint;
  type: string;
}> = [
  { field: "hatAccessory", attachment: "Hat", type: "Hat" },
  { field: "hairAccessory", attachment: "Hair", type: "Hair" },
  { field: "faceAccessory", attachment: "Face", type: "Face" },
  { field: "neckAccessory", attachment: "Neck", type: "Neck" },
  { field: "shouldersAccessory", attachment: "Shoulder", type: "Shoulder" },
  { field: "frontAccessory", attachment: "Front", type: "Front" },
  { field: "backAccessory", attachment: "Back", type: "Back" },
  { field: "waistAccessory", attachment: "Waist", type: "Waist" },
];

const PART_FOR_COLOR: Array<[keyof HumanoidDescriptionData, string]> = [
  ["headColor", "Head"],
  ["torsoColor", "Torso"],
  ["leftArmColor", "Left Arm"],
  ["rightArmColor", "Right Arm"],
  ["leftLegColor", "Left Leg"],
  ["rightLegColor", "Right Leg"],
];

export const DEFAULT_DESCRIPTION: HumanoidDescriptionData = {
  headColor: 0xf3d9a4,
  torsoColor: 0x3b6ea5,
  leftArmColor: 0xf3d9a4,
  rightArmColor: 0xf3d9a4,
  leftLegColor: 0x2e4a63,
  rightLegColor: 0x2e4a63,
  shirt: 0,
  pants: 0,
  graphicTShirt: 0,
  face: 6001,
  hatAccessory: "",
  hairAccessory: "5001",
  heightScale: 1,
  widthScale: 1,
  headScale: 1,
  walkSpeed: 16,
  jumpPower: 50,
  maxHealth: 100,
};

/** A recognisable stand-in, for "spawn a template player" in Studio. */
export const TEMPLATE_DESCRIPTION: HumanoidDescriptionData = {
  ...DEFAULT_DESCRIPTION,
  displayName: "Template",
  torsoColor: 0x7a4fb5,
  leftLegColor: 0x2b2f45,
  rightLegColor: 0x2b2f45,
  shirt: 1005,
  pants: 2004,
  hatAccessory: "4001",
  hairAccessory: "5003",
};

export class AvatarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AvatarError";
  }
}

/**
 * Checks a description before it is stored or applied.
 *
 * Every wearable slot only accepts ids of its own kind, which is what stops a
 * hat id in the Pants field quietly producing a character with no trousers.
 */
export function validateDescription(data: HumanoidDescriptionData): string[] {
  const problems: string[] = [];
  const check = (id: number | undefined, type: string, label: string): void => {
    if (!id) return;
    if (!isCompatible(id, type as never)) {
      problems.push(`${id} is not a ${label} asset`);
    }
  };
  check(data.shirt, "Shirt", "shirt");
  check(data.pants, "Pants", "pants");
  check(data.graphicTShirt, "TShirt", "t-shirt");
  check(data.face, "Face", "face");
  for (const slot of ACCESSORY_SLOTS) {
    for (const id of parseAssetList(data[slot.field] as string)) {
      if (!getAsset(id)) problems.push(`${id} is not a known accessory`);
    }
  }
  for (const key of ["heightScale", "widthScale", "headScale"] as const) {
    const value = data[key];
    if (value !== undefined && (value < 0.5 || value > 2.5)) {
      problems.push(`${key} must be between 0.5 and 2.5`);
    }
  }
  return problems;
}

/**
 * Builds a character from a description.
 *
 * Everything it produces is ordinary replicated state - part colours,
 * TextureId strings and child instances - so no client needs avatar-specific
 * code to display one.
 */
export function buildAvatar(
  data: HumanoidDescriptionData = DEFAULT_DESCRIPTION,
  opts: CharacterOptions = {},
): Model {
  const description = { ...DEFAULT_DESCRIPTION, ...data };
  const model = buildCharacter(opts);
  applyDescriptionTo(model, description);
  if (description.displayName) model.Name = opts.name ?? description.displayName;
  return model;
}

/**
 * Applies a description to an existing rig, replacing whatever it had on.
 *
 * Works on any model with a Humanoid, so it re-dresses a player's character in
 * place rather than forcing a respawn.
 */
export function applyDescriptionTo(model: Model, data: HumanoidDescriptionData): void {
  const description = { ...DEFAULT_DESCRIPTION, ...data };
  const root = model.FindFirstChild("HumanoidRootPart") as BasePart | null;
  const origin = root?.CFrame.position ?? Vector3.zero;

  // Clear what is already worn, so applying twice does not stack hats.
  for (const child of model.GetChildren()) {
    if (
      child instanceof Accessory ||
      child instanceof Shirt ||
      child instanceof Pants ||
      child instanceof ShirtGraphic
    ) {
      child.Destroy();
    }
  }

  for (const [field, partName] of PART_FOR_COLOR) {
    const part = model.FindFirstChild(partName) as BasePart | null;
    const value = description[field];
    if (part && typeof value === "number") part.setProperty("Color", Color3.fromHex(value));
  }

  applyScale(model, description, origin);
  applyClothing(model, description);
  applyFace(model, description);

  for (const slot of ACCESSORY_SLOTS) {
    for (const id of parseAssetList(description[slot.field] as string)) {
      const asset = getAsset(id);
      if (!asset) continue;
      attachAccessory(model, asset, slot.attachment, slot.type, origin);
    }
  }

  const humanoid = model.FindFirstChildOfClass("Humanoid") as Humanoid | null;
  if (humanoid) {
    if (description.walkSpeed !== undefined) humanoid.setProperty("WalkSpeed", description.walkSpeed);
    if (description.jumpPower !== undefined) humanoid.setProperty("JumpPower", description.jumpPower);
    if (description.maxHealth !== undefined) {
      humanoid.setProperty("MaxHealth", description.maxHealth);
      humanoid.setProperty("Health", Math.min(humanoid.Health, description.maxHealth));
    }
    // Bound here so a script can call humanoid:ApplyDescription without the
    // engine's class definitions having to know about the asset catalogue.
    humanoid.applyDescriptionHandler = (instance) => {
      applyDescriptionTo(model, fromDescriptionInstance(instance));
    };
    humanoid.describeHandler = () => toDescriptionInstance(describeAvatar(model));
  }
}

function applyClothing(model: Model, description: HumanoidDescriptionData): void {
  const shirtAsset = description.shirt ? getAsset(description.shirt) : undefined;
  if (shirtAsset?.texture) {
    const shirt = createInstance("Shirt", model) as Shirt;
    shirt.Name = "Shirt";
    shirt.ShirtTemplate = shirtAsset.texture;
    shirt.AssetId = shirtAsset.id;
    for (const name of ["Torso", "Left Arm", "Right Arm"]) {
      const part = model.FindFirstChild(name) as BasePart | null;
      if (part) part.setProperty("TextureId", shirtAsset.texture);
    }
  } else {
    for (const name of ["Torso", "Left Arm", "Right Arm"]) {
      const part = model.FindFirstChild(name) as BasePart | null;
      if (part) part.setProperty("TextureId", "");
    }
  }

  const pantsAsset = description.pants ? getAsset(description.pants) : undefined;
  const legs = ["Left Leg", "Right Leg"];
  if (pantsAsset?.texture) {
    const pants = createInstance("Pants", model) as Pants;
    pants.Name = "Pants";
    pants.PantsTemplate = pantsAsset.texture;
    pants.AssetId = pantsAsset.id;
    for (const name of legs) {
      const part = model.FindFirstChild(name) as BasePart | null;
      if (part) part.setProperty("TextureId", pantsAsset.texture);
    }
  } else {
    for (const name of legs) {
      const part = model.FindFirstChild(name) as BasePart | null;
      if (part) part.setProperty("TextureId", "");
    }
  }

  const graphicAsset = description.graphicTShirt ? getAsset(description.graphicTShirt) : undefined;
  if (graphicAsset?.texture) {
    const graphic = createInstance("ShirtGraphic", model) as ShirtGraphic;
    graphic.Name = "Shirt Graphic";
    graphic.Graphic = graphicAsset.texture;
    graphic.AssetId = graphicAsset.id;
    // A t-shirt sits over the shirt, so it wins on the torso.
    const torso = model.FindFirstChild("Torso") as BasePart | null;
    if (torso) torso.setProperty("TextureId", graphicAsset.texture);
  }
}

function applyFace(model: Model, description: HumanoidDescriptionData): void {
  const head = model.FindFirstChild("Head") as BasePart | null;
  if (!head) return;
  const asset = description.face ? getAsset(description.face) : undefined;
  head.setProperty("TextureId", asset?.texture ?? "");
}

/** Scales the rig, keeping each limb in its proper place. */
function applyScale(model: Model, description: HumanoidDescriptionData, origin: Vector3): void {
  const height = description.heightScale ?? 1;
  const width = description.widthScale ?? 1;
  const head = description.headScale ?? 1;
  if (height === 1 && width === 1 && head === 1) return;

  for (const limb of RIG_LIMBS) {
    const part = model.FindFirstChild(limb.name) as BasePart | null;
    if (!part) continue;
    const scale = limb.name === "Head" ? head : 1;
    part.setProperty(
      "Size",
      new Vector3(limb.size.x * width * scale, limb.size.y * height * scale, limb.size.z * width * scale),
    );
    part.setProperty(
      "CFrame",
      CFrame.fromPosition(
        origin.add(new Vector3(limb.offset.x * width, limb.offset.y * height, limb.offset.z * width)),
      ),
    );
  }
  const root = model.FindFirstChild("HumanoidRootPart") as BasePart | null;
  if (root) {
    root.setProperty("Size", new Vector3(2 * width, 2 * height, 1 * width));
  }
}

/** Adds one accessory, as an Accessory containing a Handle. */
export function attachAccessory(
  model: Model,
  asset: AssetInfo,
  attachment: AttachmentPoint,
  accessoryType: string,
  origin: Vector3,
): Accessory {
  const accessory = createInstance("Accessory", model) as Accessory;
  accessory.Name = asset.name;
  accessory.AttachmentPoint = attachment;
  accessory.AccessoryType = accessoryType;
  accessory.AssetId = asset.id;
  const offset = Vector3.fromArray(asset.offset ?? [0, 0, 0]);
  accessory.AttachmentOffset = offset;

  // Built detached and parented last: a renderer watching for new instances
  // would otherwise see the handle before it knows what mesh to draw.
  const handle = createInstance("MeshPart") as MeshPart;
  handle.Name = "Handle";
  handle.MeshId = asset.meshId ?? "builtin:sphere";
  handle.TextureId = asset.texture ?? "";
  handle.Size = Vector3.fromArray(asset.scale ?? [1, 1, 1]);
  handle.Color = Color3.fromHex(asset.color ?? 0xffffff);
  // Worn items must not shove their wearer around or block a shot.
  handle.CanCollide = false;
  handle.CanQuery = false;
  handle.Massless = true;
  handle.Anchored = false;
  handle.CFrame = CFrame.fromPosition(
    origin.add(ATTACHMENT_OFFSETS[attachment] ?? Vector3.zero).add(offset),
  );
  handle.setParent(accessory);
  return accessory;
}

/** Reads a description back out of a built character. */
export function describeAvatar(model: Model): HumanoidDescriptionData {
  const data: HumanoidDescriptionData = {};
  for (const [field, partName] of PART_FOR_COLOR) {
    const part = model.FindFirstChild(partName) as BasePart | null;
    if (part) (data as Record<string, unknown>)[field] = part.Color.toHex();
  }

  const shirt = model.FindFirstChildOfClass("Shirt") as Shirt | null;
  const pants = model.FindFirstChildOfClass("Pants") as Pants | null;
  const graphic = model.FindFirstChildOfClass("ShirtGraphic") as ShirtGraphic | null;
  data.shirt = shirt?.AssetId ?? 0;
  data.pants = pants?.AssetId ?? 0;
  data.graphicTShirt = graphic?.AssetId ?? 0;

  const bySlot = new Map<string, number[]>();
  for (const child of model.GetChildren()) {
    if (!(child instanceof Accessory) || !child.AssetId) continue;
    const list = bySlot.get(child.AccessoryType) ?? [];
    list.push(child.AssetId);
    bySlot.set(child.AccessoryType, list);
  }
  for (const slot of ACCESSORY_SLOTS) {
    const ids = bySlot.get(slot.type);
    if (ids?.length) (data as Record<string, unknown>)[slot.field] = ids.join(",");
  }

  const humanoid = model.FindFirstChildOfClass("Humanoid") as Humanoid | null;
  if (humanoid) {
    data.walkSpeed = humanoid.WalkSpeed;
    data.jumpPower = humanoid.JumpPower;
    data.maxHealth = humanoid.MaxHealth;
  }
  const head = model.FindFirstChild("Head") as BasePart | null;
  const torso = model.FindFirstChild("Torso") as BasePart | null;
  if (head && torso) {
    data.headScale = Math.round((head.Size.x / 2) * 100) / 100;
    data.heightScale = Math.round((torso.Size.y / 2) * 100) / 100;
    data.widthScale = Math.round((torso.Size.x / 2) * 100) / 100;
  }
  return data;
}

// -- converting to and from the instance form --------------------------------

const INSTANCE_FIELDS: Array<[keyof HumanoidDescriptionData, string, "color" | "number" | "string"]> = [
  ["headColor", "HeadColor", "color"],
  ["torsoColor", "TorsoColor", "color"],
  ["leftArmColor", "LeftArmColor", "color"],
  ["rightArmColor", "RightArmColor", "color"],
  ["leftLegColor", "LeftLegColor", "color"],
  ["rightLegColor", "RightLegColor", "color"],
  ["shirt", "Shirt", "number"],
  ["pants", "Pants", "number"],
  ["graphicTShirt", "GraphicTShirt", "number"],
  ["face", "Face", "number"],
  ["hatAccessory", "HatAccessory", "string"],
  ["hairAccessory", "HairAccessory", "string"],
  ["faceAccessory", "FaceAccessory", "string"],
  ["neckAccessory", "NeckAccessory", "string"],
  ["shouldersAccessory", "ShouldersAccessory", "string"],
  ["frontAccessory", "FrontAccessory", "string"],
  ["backAccessory", "BackAccessory", "string"],
  ["waistAccessory", "WaistAccessory", "string"],
  ["heightScale", "HeightScale", "number"],
  ["widthScale", "WidthScale", "number"],
  ["headScale", "HeadScale", "number"],
  ["walkSpeed", "WalkSpeed", "number"],
  ["jumpPower", "JumpPower", "number"],
  ["maxHealth", "MaxHealth", "number"],
  ["displayName", "DisplayName", "string"],
];

/** Plain data -> a HumanoidDescription instance a script can hold. */
export function toDescriptionInstance(
  data: HumanoidDescriptionData,
  parent?: Instance | null,
): HumanoidDescription {
  const instance = createInstance("HumanoidDescription", parent) as HumanoidDescription;
  instance.Name = "HumanoidDescription";
  const record = instance as unknown as Record<string, unknown>;
  for (const [field, property, kind] of INSTANCE_FIELDS) {
    const value = data[field];
    if (value === undefined) continue;
    record[property] = kind === "color" ? Color3.fromHex(value as number) : value;
  }
  return instance;
}

/** A HumanoidDescription instance -> plain data. */
export function fromDescriptionInstance(
  instance: HumanoidDescription,
): HumanoidDescriptionData {
  const data: HumanoidDescriptionData = {};
  const record = instance as unknown as Record<string, unknown>;
  for (const [field, property, kind] of INSTANCE_FIELDS) {
    const value = record[property];
    if (value === undefined) continue;
    (data as Record<string, unknown>)[field] =
      kind === "color" ? (value as Color3).toHex() : value;
  }
  return data;
}

export { getAsset, isCompatible, parseAssetList };
