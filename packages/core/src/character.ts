import { CFrame, Color3, Vector3 } from "./math.js";
import { createInstance, type Instance } from "./instance.js";
import { BasePart, Humanoid, Model, Motor6D, Part } from "./classes.js";

/**
 * PLACEHOLDER AVATAR.
 *
 * A blocky six-limb rig in the classic proportions, assembled from plain Parts
 * so it needs no mesh assets. It exists so the game is playable while the real
 * custom avatar model is still being made. To swap it out, replace
 * `buildCharacter` with a loader for the finished model: everything else keys
 * off the Humanoid plus a part named "HumanoidRootPart", so as long as the
 * replacement provides those two, the engine will not notice the difference.
 */

export interface RigLimb {
  name: string;
  size: Vector3;
  /** Offset from the torso centre, in studs. */
  offset: Vector3;
  color: Color3;
  /** Joint pivot on the torso, for Motor6D animation. */
  jointC0?: Vector3;
}

export const PLACEHOLDER_SKIN = {
  head: Color3.fromHex(0xf3d9a4),
  torso: Color3.fromHex(0x3b6ea5),
  arms: Color3.fromHex(0xf3d9a4),
  legs: Color3.fromHex(0x2e4a63),
};

export const ROOT_SIZE = new Vector3(2, 2, 1);
/**
 * Distance from the root's centre down to the soles.
 *
 * The root is the torso's box, so the legs hang below it. Physics needs this
 * to rest a character on its feet rather than on its hips.
 */
export const HIP_TO_GROUND = 3;

/** How far the feet sit below the root part's own box. */
export const DEFAULT_HIP_HEIGHT = HIP_TO_GROUND - ROOT_SIZE.y / 2;

export const RIG_LIMBS: RigLimb[] = [
  {
    name: "Head",
    size: new Vector3(2, 1, 1),
    offset: new Vector3(0, 1.5, 0),
    color: PLACEHOLDER_SKIN.head,
    jointC0: new Vector3(0, 1, 0),
  },
  {
    name: "Torso",
    size: new Vector3(2, 2, 1),
    offset: new Vector3(0, 0, 0),
    color: PLACEHOLDER_SKIN.torso,
  },
  {
    name: "Left Arm",
    size: new Vector3(1, 2, 1),
    offset: new Vector3(-1.5, 0, 0),
    color: PLACEHOLDER_SKIN.arms,
    jointC0: new Vector3(-1, 0.5, 0),
  },
  {
    name: "Right Arm",
    size: new Vector3(1, 2, 1),
    offset: new Vector3(1.5, 0, 0),
    color: PLACEHOLDER_SKIN.arms,
    jointC0: new Vector3(1, 0.5, 0),
  },
  {
    name: "Left Leg",
    size: new Vector3(1, 2, 1),
    offset: new Vector3(-0.5, -2, 0),
    color: PLACEHOLDER_SKIN.legs,
    jointC0: new Vector3(-0.5, -1, 0),
  },
  {
    name: "Right Leg",
    size: new Vector3(1, 2, 1),
    offset: new Vector3(0.5, -2, 0),
    color: PLACEHOLDER_SKIN.legs,
    jointC0: new Vector3(0.5, -1, 0),
  },
];

export interface CharacterOptions {
  name?: string;
  position?: Vector3;
  walkSpeed?: number;
  jumpPower?: number;
  colors?: Partial<typeof PLACEHOLDER_SKIN>;
}

export function buildCharacter(opts: CharacterOptions = {}): Model {
  const position = opts.position ?? new Vector3(0, 10, 0);
  const model = createInstance("Model") as Model;
  model.Name = opts.name ?? "Character";

  // The root is the only part physics moves; limbs are carried along.
  const root = createInstance("Part") as Part;
  root.Name = "HumanoidRootPart";
  root.Size = ROOT_SIZE;
  root.CFrame = CFrame.fromPosition(position);
  root.Transparency = 1;
  root.CanCollide = true;
  root.Anchored = false;
  root.setParent(model);
  model.PrimaryPart = root;

  const colors = { ...PLACEHOLDER_SKIN, ...opts.colors };
  let torso: BasePart | null = null;
  const limbs: Array<{ part: Part; limb: RigLimb }> = [];

  for (const limb of RIG_LIMBS) {
    const part = createInstance("Part") as Part;
    part.Name = limb.name;
    part.Size = limb.size;
    part.CFrame = CFrame.fromPosition(position.add(limb.offset));
    part.Color =
      limb.name === "Head"
        ? colors.head
        : limb.name === "Torso"
          ? colors.torso
          : limb.name.endsWith("Arm")
            ? colors.arms
            : colors.legs;
    part.Material = "Plastic";
    // Only the root collides; limbs would otherwise snag on geometry.
    part.CanCollide = false;
    part.Anchored = false;
    part.setParent(model);
    if (limb.name === "Torso") torso = part;
    limbs.push({ part, limb });
  }

  // Motor6D joints let the client animate limbs without server round-trips.
  if (torso) {
    for (const { part, limb } of limbs) {
      if (!limb.jointC0) continue;
      const motor = createInstance("Motor6D") as Motor6D;
      motor.Name = `${limb.name} Joint`;
      motor.Part0 = torso;
      motor.Part1 = part;
      motor.C0 = CFrame.fromPosition(limb.jointC0);
      motor.C1 = CFrame.fromPosition(
        new Vector3(0, limb.name === "Head" ? -0.5 : limb.name.endsWith("Arm") ? 0.5 : 1, 0),
      );
      motor.setParent(torso);
    }
    const rootJoint = createInstance("Motor6D") as Motor6D;
    rootJoint.Name = "RootJoint";
    rootJoint.Part0 = root;
    rootJoint.Part1 = torso;
    rootJoint.setParent(root);
  }

  const humanoid = createInstance("Humanoid") as Humanoid;
  humanoid.Name = "Humanoid";
  humanoid.WalkSpeed = opts.walkSpeed ?? 16;
  humanoid.JumpPower = opts.jumpPower ?? 50;
  // Without this the solver rests the root box on the ground and the legs,
  // which hang below it, end up buried.
  humanoid.HipHeight = DEFAULT_HIP_HEIGHT;
  humanoid.setParent(model);

  return model;
}

/**
 * Builds the character a player should spawn with.
 *
 * Looks for a Model named "StarterCharacter" under StarterPlayer and clones it,
 * exactly as Roblox does, so a place can ship its own rig without touching the
 * engine. Anything under StarterCharacterScripts is copied into the result.
 *
 * A custom rig only has to provide two things for the engine to drive it: a
 * Humanoid, and a part named "HumanoidRootPart". Everything else about it is
 * the place's business.
 */
export function loadCharacterFor(
  starterPlayer: Instance | null,
  opts: CharacterOptions = {},
): { model: Model; custom: boolean } {
  const template = starterPlayer?.FindFirstChild("StarterCharacter");
  const position = opts.position ?? new Vector3(0, 10, 0);

  let model: Model;
  let custom = false;
  if (template instanceof Model && isValidRig(template)) {
    const clone = template.Clone();
    if (clone instanceof Model) {
      model = clone;
      custom = true;
      model.Name = opts.name ?? "Character";
      // The template sits wherever the builder left it; move it to the spawn.
      const root = model.FindFirstChild("HumanoidRootPart") as BasePart | null;
      if (root) {
        model.PrimaryPart = root;
        model.MoveTo(position);
      }
    } else {
      model = buildCharacter(opts);
    }
  } else {
    model = buildCharacter(opts);
  }

  const scripts = starterPlayer?.FindFirstChild("StarterCharacterScripts");
  for (const script of scripts?.GetChildren() ?? []) {
    const copy = script.Clone();
    if (copy) copy.setParent(model);
  }
  return { model, custom };
}

/** A rig the engine can drive: a Humanoid and a part to move it by. */
export function isValidRig(model: Instance): boolean {
  return (
    !!model.FindFirstChildOfClass("Humanoid") && !!model.FindFirstChild("HumanoidRootPart")
  );
}

/** Local offsets of each rig part from the root, for client-side animation. */
export function rigOffsets(): Array<{ name: string; offset: Vector3; size: Vector3 }> {
  return RIG_LIMBS.map((limb) => ({ name: limb.name, offset: limb.offset, size: limb.size }));
}
