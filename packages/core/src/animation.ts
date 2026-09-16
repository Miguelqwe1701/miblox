import { CFrame, Vector3 } from "./math.js";
import { Accessory, BasePart, Humanoid, Model } from "./classes.js";
import { ATTACHMENT_OFFSETS, type AttachmentPoint } from "./avatar.js";

/**
 * Procedural animation for the blocky rig.
 *
 * There are no animation assets: poses are computed from the humanoid's state
 * and speed, the way a keyframe-free R6 rig works. That keeps characters
 * animated with no download, no bandwidth beyond the part CFrames already
 * being replicated, and no difference between a server-simulated character and
 * one a client owns - both run this same function.
 *
 * Everything is expressed in the root part's space, so a character's pose is
 * independent of where it stands or which way it faces.
 */

export type LimbName = "Head" | "Torso" | "Left Arm" | "Right Arm" | "Left Leg" | "Right Leg";

export const LIMB_NAMES: LimbName[] = [
  "Head",
  "Torso",
  "Left Arm",
  "Right Arm",
  "Left Leg",
  "Right Leg",
];

/** A joint rotation, in radians. */
export interface JointPose {
  rx: number;
  ry: number;
  rz: number;
}

export interface RigPose {
  /** Vertical bob of the upper body, in studs. Feet stay put. */
  bob: number;
  joints: Record<LimbName, JointPose>;
}

const still = (): JointPose => ({ rx: 0, ry: 0, rz: 0 });

function emptyPose(): RigPose {
  return {
    bob: 0,
    joints: {
      Head: still(),
      Torso: still(),
      "Left Arm": still(),
      "Right Arm": still(),
      "Left Leg": still(),
      "Right Leg": still(),
    },
  };
}

/**
 * The pose for a humanoid in a given state.
 *
 * `phase` advances with distance travelled rather than with time, so a walk
 * cycle stays in step with the ground however fast the character moves, and
 * `clock` is plain elapsed time for idling.
 */
export function poseFor(
  state: string,
  speed: number,
  walkSpeed: number,
  phase: number,
  clock: number,
): RigPose {
  const pose = emptyPose();
  const j = pose.joints;

  if (state === "Dead") {
    // Limbs splayed: unmistakable at a glance, and no cycle to keep running.
    j["Left Arm"].rz = 1.4;
    j["Right Arm"].rz = -1.4;
    j["Left Leg"].rz = 0.4;
    j["Right Leg"].rz = -0.4;
    j.Head.rx = 0.5;
    return pose;
  }

  if (state === "Swimming") {
    const stroke = Math.sin(clock * 4);
    j["Left Arm"].rx = -1.5 + stroke * 0.5;
    j["Right Arm"].rx = -1.5 - stroke * 0.5;
    j["Left Leg"].rx = stroke * 0.35;
    j["Right Leg"].rx = -stroke * 0.35;
    return pose;
  }

  if (state === "Jumping" || state === "Freefall") {
    const rising = state === "Jumping";
    // Arms up on the way up, flailing wider on the way down.
    j["Left Arm"].rx = rising ? -2.0 : -2.4;
    j["Right Arm"].rx = rising ? -2.0 : -2.4;
    j["Left Arm"].rz = rising ? 0.2 : 0.5;
    j["Right Arm"].rz = rising ? -0.2 : -0.5;
    // Legs tuck under on the rise and reach for the ground on the fall.
    j["Left Leg"].rx = rising ? 0.5 : -0.25;
    j["Right Leg"].rx = rising ? -0.2 : 0.35;
    return pose;
  }

  const reference = walkSpeed > 0 ? walkSpeed : 16;
  const effort = Math.min(speed / reference, 1.6);
  if (effort < 0.05) {
    // Idle: a slow breath, so a standing character is never a frozen statue.
    const breath = Math.sin(clock * 1.6);
    j["Left Arm"].rz = 0.06 + breath * 0.025;
    j["Right Arm"].rz = -0.06 - breath * 0.025;
    j.Head.ry = Math.sin(clock * 0.6) * 0.09;
    pose.bob = breath * 0.035;
    return pose;
  }

  // Walk and run share one cycle; the swing just gets bigger with effort.
  const swing = Math.sin(phase) * (0.25 + effort * 0.55);
  j["Left Leg"].rx = swing;
  j["Right Leg"].rx = -swing;
  // Arms counter-swing against the leg on the same side, as people walk.
  j["Left Arm"].rx = -swing * 0.85;
  j["Right Arm"].rx = swing * 0.85;
  // Arms held a little out from the body so they clear the torso.
  j["Left Arm"].rz = 0.07;
  j["Right Arm"].rz = -0.07;
  // Two footfalls per cycle, so the bob runs at double the swing.
  pose.bob = Math.abs(Math.sin(phase)) * 0.12 * effort - 0.06 * effort;
  j.Head.rx = -0.03 * effort;
  return pose;
}

/** Where each rig part sits, and which joint it swings around, at rest. */
interface RigGeometry {
  /** Rest offset from the root's centre, in root space. */
  rest: Map<LimbName, Vector3>;
  /** Pivot the limb rotates about, in root space. */
  pivot: Map<LimbName, Vector3>;
}

/**
 * Works the rig's joint positions out from the parts themselves.
 *
 * Deriving these from the current Sizes rather than hard-coding them means a
 * scaled avatar - a taller body, a bigger head - gets joints in the right
 * places without a second set of numbers to keep in step.
 */
function rigGeometry(model: Model): RigGeometry | null {
  const part = (name: string) => model.FindFirstChild(name) as BasePart | null;
  const torso = part("Torso");
  if (!torso) return null;
  const halfX = torso.Size.x / 2;
  const halfY = torso.Size.y / 2;

  const rest = new Map<LimbName, Vector3>();
  const pivot = new Map<LimbName, Vector3>();

  rest.set("Torso", Vector3.zero);
  pivot.set("Torso", Vector3.zero);

  const head = part("Head");
  if (head) {
    rest.set("Head", new Vector3(0, halfY + head.Size.y / 2, 0));
    pivot.set("Head", new Vector3(0, halfY, 0));
  }
  for (const [name, sign] of [
    ["Left Arm", -1],
    ["Right Arm", 1],
  ] as Array<[LimbName, number]>) {
    const arm = part(name);
    if (!arm) continue;
    rest.set(name, new Vector3(sign * (halfX + arm.Size.x / 2), 0, 0));
    pivot.set(name, new Vector3(sign * halfX, halfY, 0));
  }
  for (const [name, sign] of [
    ["Left Leg", -1],
    ["Right Leg", 1],
  ] as Array<[LimbName, number]>) {
    const leg = part(name);
    if (!leg) continue;
    rest.set(name, new Vector3(sign * (leg.Size.x / 2), -(halfY + leg.Size.y / 2), 0));
    pivot.set(name, new Vector3(sign * (leg.Size.x / 2), -halfY, 0));
  }
  return { rest, pivot };
}

/** Which limb a worn accessory rides on. */
function jointForAttachment(point: string): LimbName {
  switch (point) {
    case "Hat":
    case "Hair":
    case "Head":
    case "Face":
      return "Head";
    case "LeftHand":
      return "Left Arm";
    case "RightHand":
      return "Right Arm";
    default:
      return "Torso";
  }
}

/** Rotation about a pivot, in root space. */
function jointTransform(pivot: Vector3, pose: JointPose): CFrame {
  if (pose.rx === 0 && pose.ry === 0 && pose.rz === 0) return CFrame.identity;
  return CFrame.fromPosition(pivot)
    .mul(CFrame.angles(pose.rx, pose.ry, pose.rz))
    .mul(CFrame.fromPosition(pivot.mul(-1)));
}

/**
 * Rest offsets for parts that are not part of the standard rig.
 *
 * Captured the first time a part is seen, which is the frame it spawns in, so
 * a custom rig's extra parts turn with the character instead of sliding around
 * it in world space.
 */
const capturedRest = new WeakMap<BasePart, CFrame>();

/** Puts every part of a character where the given pose says it goes. */
export function applyPose(model: Model, root: BasePart, pose: RigPose): void {
  const geometry = rigGeometry(model);
  const rootCF = root.CFrame;
  const bob = new Vector3(0, pose.bob, 0);

  const jointCF = new Map<LimbName, CFrame>();
  if (geometry) {
    for (const name of LIMB_NAMES) {
      const pivot = geometry.pivot.get(name);
      if (pivot) jointCF.set(name, jointTransform(pivot, pose.joints[name]));
    }
  }

  const place = (part: BasePart, local: CFrame) => part.setProperty("CFrame", rootCF.mul(local));

  for (const desc of model.GetDescendants()) {
    if (desc === root || !(desc instanceof BasePart)) continue;

    // A standard limb: rotate it about its joint.
    const limb = desc.Name as LimbName;
    if (geometry && geometry.rest.has(limb) && desc.Parent === model) {
      const rest = geometry.rest.get(limb)!;
      const joint = jointCF.get(limb) ?? CFrame.identity;
      // Feet carry the body's weight, so the bob lifts everything but the legs.
      const lift = limb === "Left Leg" || limb === "Right Leg" ? Vector3.zero : bob;
      place(desc, joint.mul(CFrame.fromPosition(rest.add(lift))));
      continue;
    }

    // A worn accessory: rides whichever limb it is attached to. Its rest
    // position comes from the attachment point rather than from wherever the
    // handle happens to be, because a handle is built at the character's spawn
    // point and the character has usually moved by the time it is first seen.
    const owner = desc.Parent;
    if (owner instanceof Accessory) {
      const point = owner.AttachmentPoint as AttachmentPoint;
      const joint = jointCF.get(jointForAttachment(point)) ?? CFrame.identity;
      const rest = (ATTACHMENT_OFFSETS[point] ?? Vector3.zero).add(owner.AttachmentOffset);
      place(desc, joint.mul(CFrame.fromPosition(rest.add(bob))));
      continue;
    }

    // Anything else - a custom rig's extra parts - rides the root rigidly.
    let rest = capturedRest.get(desc);
    if (!rest) {
      rest = rootCF.inverse().mul(desc.CFrame);
      capturedRest.set(desc, rest);
    }
    place(desc, rest);
  }
}

/** Per-character cycle state, so a walk does not restart every frame. */
interface AnimatorState {
  phase: number;
  clock: number;
}

const animators = new WeakMap<Model, AnimatorState>();

/**
 * Advances and applies a character's animation.
 *
 * Called by the physics step once the root has been moved, so limbs are posed
 * against the position they will actually be drawn at this frame.
 */
export function animateCharacter(
  model: Model,
  humanoid: Humanoid,
  root: BasePart,
  dt: number,
): void {
  let state = animators.get(model);
  if (!state) {
    state = { phase: 0, clock: 0 };
    animators.set(model, state);
  }
  const velocity = root.AssemblyLinearVelocity;
  const speed = Math.hypot(velocity.x, velocity.z);
  state.clock += dt;
  // One radian per 0.55 studs: a 16 studs/second walk comes out at a shade
  // under one and a half strides a second, which reads as a walk rather than
  // a scurry.
  state.phase = (state.phase + speed * dt * 0.55) % (Math.PI * 2);
  applyPose(model, root, poseFor(humanoid.state, speed, humanoid.WalkSpeed, state.phase, state.clock));
}

/** Forgets a character's cycle, so a respawned rig starts from rest. */
export function resetAnimation(model: Model): void {
  animators.delete(model);
}
