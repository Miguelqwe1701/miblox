import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CFrame,
  DataModel,
  PhysicsWorld,
  Vector3,
  ATTACHMENT_OFFSETS,
  applyPose,
  buildAvatar,
  buildCharacter,
  createInstance,
  poseFor,
} from "../dist/index.js";

function makeWorld() {
  const game = new DataModel();
  game.Terrain.voxels.generateOnAccess = false;
  return { game, physics: new PhysicsWorld(game.Workspace, game.Terrain.voxels) };
}

/** A character standing on a wide anchored slab, so it has ground under it. */
function standing(game) {
  const ground = createInstance("Part", game.Workspace);
  ground.Anchored = true;
  ground.Size = new Vector3(200, 4, 200);
  ground.CFrame = CFrame.fromPosition(new Vector3(0, 0, 0));
  const model = buildCharacter({ position: new Vector3(0, 10, 0) });
  model.Parent = game.Workspace;
  return { ground, model, humanoid: model.FindFirstChildOfClass("Humanoid"), root: model.FindFirstChild("HumanoidRootPart") };
}

const limb = (model, name) => model.FindFirstChild(name);
const local = (root, part) => root.CFrame.inverse().mul(part.CFrame).position;

test("an idle pose leaves the legs under the body", () => {
  const pose = poseFor("Running", 0, 16, 0, 0);
  assert.equal(pose.joints["Left Leg"].rx, 0);
  assert.equal(pose.joints["Right Leg"].rx, 0);
});

test("walking swings opposite legs, and each arm against its own leg", () => {
  // A quarter through the cycle is the widest part of the stride.
  const pose = poseFor("Running", 16, 16, Math.PI / 2, 0);
  const j = pose.joints;
  assert.ok(j["Left Leg"].rx > 0.3, `left leg swung ${j["Left Leg"].rx}`);
  assert.equal(j["Right Leg"].rx, -j["Left Leg"].rx);
  // Opposite limbs move together: left leg forward means right arm forward.
  assert.ok(Math.sign(j["Right Arm"].rx) === Math.sign(j["Left Leg"].rx));
  assert.ok(Math.sign(j["Left Arm"].rx) === Math.sign(j["Right Leg"].rx));
});

test("running swings wider than walking", () => {
  const walk = poseFor("Running", 8, 16, Math.PI / 2, 0).joints["Left Leg"].rx;
  const run = poseFor("Running", 24, 16, Math.PI / 2, 0).joints["Left Leg"].rx;
  assert.ok(run > walk, `run ${run} should swing wider than walk ${walk}`);
});

test("a jump throws the arms up", () => {
  assert.ok(poseFor("Jumping", 0, 16, 0, 0).joints["Left Arm"].rx < -1.5);
  assert.ok(poseFor("Freefall", 0, 16, 0, 0).joints["Right Arm"].rx < -1.5);
});

test("a standing character still breathes, so it is never a frozen statue", () => {
  const a = poseFor("Running", 0, 16, 0, 0.0);
  const b = poseFor("Running", 0, 16, 0, 1.0);
  assert.notEqual(a.joints["Left Arm"].rz, b.joints["Left Arm"].rz);
});

test("limbs turn with the character rather than staying world-aligned", () => {
  const { game, physics } = makeWorld();
  const { model, humanoid, root } = standing(game);
  // Let it land first: a falling character is posed for freefall, not standing.
  for (let i = 0; i < 90; i++) physics.step(1 / 60);

  // Face the character down +X and check the head is still directly above it.
  root.CFrame = CFrame.angles(0, Math.PI / 2, 0).add(root.CFrame.position);
  humanoid.MoveDirection = Vector3.zero;
  physics.step(1 / 60);

  const head = limb(model, "Head");
  const offset = head.CFrame.position.sub(root.CFrame.position);
  assert.ok(Math.abs(offset.x) < 0.05, `head drifted sideways: ${offset}`);
  assert.ok(Math.abs(offset.z) < 0.05, `head drifted forwards: ${offset}`);
  assert.ok(offset.y > 1, `head should sit above the root, got ${offset.y}`);

  // The arms should have turned too: the left arm is on the character's own
  // left, which after a quarter turn points along -Z... or +Z, depending on
  // the turn's sign. Either way it must no longer be offset along X.
  const arm = local(root, limb(model, "Left Arm"));
  assert.ok(arm.x < -1, `left arm should stay on the body's left, got ${arm}`);
});

test("a walking character's legs actually move", () => {
  const { game, physics } = makeWorld();
  const { model, humanoid, root } = standing(game);
  for (let i = 0; i < 90; i++) physics.step(1 / 60);
  humanoid.MoveDirection = new Vector3(0, 0, -1);

  const seen = new Set();
  for (let i = 0; i < 120; i++) {
    physics.step(1 / 60);
    seen.add(Math.round(local(root, limb(model, "Left Leg")).z * 20));
  }
  assert.ok(seen.size > 4, `the left leg only took ${seen.size} distinct positions`);
});

test("a standing character's legs stay still", () => {
  const { game, physics } = makeWorld();
  const { model, root } = standing(game);
  for (let i = 0; i < 90; i++) physics.step(1 / 60);
  const before = local(root, limb(model, "Left Leg"));
  for (let i = 0; i < 60; i++) physics.step(1 / 60);
  const after = local(root, limb(model, "Left Leg"));
  assert.ok(after.sub(before).magnitude < 0.01, `idle legs drifted by ${after.sub(before).magnitude}`);
});

test("animating does not move the feet off the ground", () => {
  const { game, physics } = makeWorld();
  const { model, humanoid, root } = standing(game);
  humanoid.MoveDirection = new Vector3(0, 0, -1);
  for (let i = 0; i < 180; i++) physics.step(1 / 60);
  const soles = root.CFrame.position.y - root.Size.y / 2 - humanoid.HipHeight;
  assert.ok(Math.abs(soles - 2) < 0.2, `soles ended at ${soles}, expected the slab top at 2`);
});

test("a worn hat rides the head instead of hanging in space", () => {
  const { game, physics } = makeWorld();
  const model = buildAvatar({ hatAccessory: "4001" }, { position: new Vector3(0, 10, 0) });
  model.Parent = game.Workspace;
  const root = model.FindFirstChild("HumanoidRootPart");
  const accessory = model.GetChildren().find((c) => c.className === "Accessory");
  assert.ok(accessory, "expected the avatar to be wearing a hat");
  const handle = accessory.FindFirstChild("Handle");

  for (let i = 0; i < 90; i++) physics.step(1 / 60);
  const before = local(root, handle);
  root.CFrame = CFrame.angles(0, Math.PI, 0).add(root.CFrame.position);
  physics.step(1 / 60);
  const after = local(root, handle);

  assert.ok(after.sub(before).magnitude < 0.2, `the hat slid off the head by ${after.sub(before).magnitude}`);
  assert.ok(after.y > 1.5, `the hat should sit above the head, got ${after.y}`);
});

test("a hat sits at its attachment height however far the wearer has moved", () => {
  const { game, physics } = makeWorld();
  createInstance("Part", game.Workspace).Anchored = true;
  const model = buildAvatar({ hatAccessory: "4001" }, { position: new Vector3(0, 40, 0) });
  model.Parent = game.Workspace;
  const root = model.FindFirstChild("HumanoidRootPart");
  const accessory = model.GetChildren().find((c) => c.className === "Accessory");
  const handle = accessory.FindFirstChild("Handle");

  // The handle is built at the spawn point; by the time anything looks at it
  // the character has fallen a long way. Its rest height must not drift.
  const expected = ATTACHMENT_OFFSETS[accessory.AttachmentPoint].add(accessory.AttachmentOffset).y;
  for (let i = 0; i < 120; i++) physics.step(1 / 60);
  const y = local(root, handle).y;
  assert.ok(Math.abs(y - expected) < 0.15, `hat at ${y}, expected about ${expected}`);
});

test("a pose can be applied on its own, without running physics", () => {

  const model = buildCharacter({ position: new Vector3(0, 10, 0) });
  const root = model.FindFirstChild("HumanoidRootPart");
  applyPose(model, root, poseFor("Running", 16, 16, Math.PI / 2, 0));
  assert.ok(Math.abs(local(root, limb(model, "Left Leg")).z) > 0.3, "the leg should have swung");
});

test("scaling a character keeps its joints on the body", () => {
  const game = new DataModel();
  const model = buildAvatar({ heightScale: 150 }, { position: new Vector3(0, 10, 0) });
  const root = model.FindFirstChild("HumanoidRootPart");
  const torso = limb(model, "Torso");
  applyPose(model, root, poseFor("Running", 0, 16, 0, 0));
  const head = local(root, limb(model, "Head"));
  const expected = torso.Size.y / 2 + limb(model, "Head").Size.y / 2;
  assert.ok(Math.abs(head.y - expected) < 0.01, `head at ${head.y}, expected ${expected}`);
});

