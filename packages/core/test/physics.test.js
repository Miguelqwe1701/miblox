import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DataModel,
  PhysicsWorld,
  Vector3,
  CFrame,
  createInstance,
  buildCharacter,
  rayAABB,
  MATERIAL_ID,
} from "../dist/index.js";

function makeWorld() {
  const game = new DataModel();
  game.Terrain.voxels.generateOnAccess = false;
  return { game, physics: new PhysicsWorld(game.Workspace, game.Terrain.voxels) };
}

function simulate(physics, seconds, dt = 1 / 60) {
  for (let t = 0; t < seconds; t += dt) physics.step(dt);
}

test("an unanchored part falls under gravity", () => {
  const { game, physics } = makeWorld();
  const part = createInstance("Part", game.Workspace);
  part.CFrame = CFrame.fromPosition(new Vector3(0, 100, 0));
  simulate(physics, 0.5);
  assert.ok(part.CFrame.position.y < 100, "part should have fallen");
  assert.ok(part.AssemblyLinearVelocity.y < 0);
});

test("an anchored part does not move", () => {
  const { game, physics } = makeWorld();
  const part = createInstance("Part", game.Workspace);
  part.Anchored = true;
  part.CFrame = CFrame.fromPosition(new Vector3(0, 100, 0));
  simulate(physics, 1);
  assert.equal(part.CFrame.position.y, 100);
});

test("a falling part lands on an anchored floor and settles", () => {
  const { game, physics } = makeWorld();
  const floor = createInstance("Part", game.Workspace);
  floor.Anchored = true;
  floor.Size = new Vector3(100, 4, 100);
  floor.CFrame = CFrame.fromPosition(new Vector3(0, 0, 0));

  const box = createInstance("Part", game.Workspace);
  box.Size = new Vector3(4, 4, 4);
  box.Material = "Concrete"; // Low elasticity, so it should not bounce away.
  box.CFrame = CFrame.fromPosition(new Vector3(0, 40, 0));

  simulate(physics, 4);
  const y = box.CFrame.position.y;
  // Floor top is y=2, box half-height 2, so it rests at y=4.
  assert.ok(Math.abs(y - 4) < 0.75, `expected to rest near y=4, got ${y}`);
});

test("a part lands on voxel terrain rather than falling through", () => {
  const { game, physics } = makeWorld();
  // A 3x3 pad of solid voxels spanning world y 0..4.
  for (let x = -1; x <= 1; x++)
    for (let z = -1; z <= 1; z++) game.Terrain.SetVoxel(x, 0, z, MATERIAL_ID.Rock);

  const box = createInstance("Part", game.Workspace);
  box.Size = new Vector3(2, 2, 2);
  box.CFrame = CFrame.fromPosition(new Vector3(2, 40, 2));
  simulate(physics, 4);
  assert.ok(box.CFrame.position.y > 3, `expected to rest on terrain, got ${box.CFrame.position.y}`);
});

test("parts below FallenPartsDestroyHeight are culled", () => {
  const { game, physics } = makeWorld();
  game.Workspace.FallenPartsDestroyHeight = -50;
  const part = createInstance("Part", game.Workspace);
  part.CFrame = CFrame.fromPosition(new Vector3(0, -60, 0));
  physics.step(1 / 60);
  assert.ok(part.destroyed);
});

test("a character walks when MoveDirection is set", () => {
  const { game, physics } = makeWorld();
  const floor = createInstance("Part", game.Workspace);
  floor.Anchored = true;
  floor.Size = new Vector3(400, 4, 400);
  floor.CFrame = CFrame.fromPosition(Vector3.zero);

  const char = buildCharacter({ position: new Vector3(0, 10, 0) });
  char.Parent = game.Workspace;
  const humanoid = char.FindFirstChildOfClass("Humanoid");
  const root = char.FindFirstChild("HumanoidRootPart");

  simulate(physics, 1); // Let it settle onto the floor.
  const restY = root.CFrame.position.y;
  humanoid.MoveDirection = new Vector3(1, 0, 0);
  simulate(physics, 1);

  assert.ok(root.CFrame.position.x > 5, `expected to walk east, x=${root.CFrame.position.x}`);
  assert.ok(Math.abs(root.CFrame.position.y - restY) < 1.5, "should stay on the ground");
});

test("a grounded character jumps and comes back down", () => {
  const { game, physics } = makeWorld();
  const floor = createInstance("Part", game.Workspace);
  floor.Anchored = true;
  floor.Size = new Vector3(200, 4, 200);
  floor.CFrame = CFrame.fromPosition(Vector3.zero);

  const char = buildCharacter({ position: new Vector3(0, 10, 0) });
  char.Parent = game.Workspace;
  const humanoid = char.FindFirstChildOfClass("Humanoid");
  const root = char.FindFirstChild("HumanoidRootPart");

  simulate(physics, 1);
  const restY = root.CFrame.position.y;
  humanoid.Jump = true;
  physics.step(1 / 60);
  assert.ok(root.AssemblyLinearVelocity.y > 0, "jump should give upward velocity");
  simulate(physics, 0.3);
  assert.ok(root.CFrame.position.y > restY, "should be airborne");
  simulate(physics, 3);
  assert.ok(Math.abs(root.CFrame.position.y - restY) < 1.5, "should land again");
});

test("character limbs follow the root", () => {
  const { game, physics } = makeWorld();
  const char = buildCharacter({ position: new Vector3(0, 50, 0) });
  char.Parent = game.Workspace;
  const root = char.FindFirstChild("HumanoidRootPart");
  const head = char.FindFirstChild("Head");
  const before = head.CFrame.position.sub(root.CFrame.position);
  simulate(physics, 0.5);
  const after = head.CFrame.position.sub(root.CFrame.position);
  assert.ok(after.sub(before).magnitude < 1e-6, "head should keep its offset from the root");
});

test("Humanoid.TakeDamage kills at zero health", () => {
  const humanoid = createInstance("Humanoid");
  let died = 0;
  humanoid.Died.Connect(() => died++);
  humanoid.TakeDamage(60);
  assert.equal(humanoid.Health, 40);
  assert.equal(died, 0);
  humanoid.TakeDamage(999);
  assert.equal(humanoid.Health, 0);
  assert.equal(died, 1);
  humanoid.TakeDamage(10); // Already dead; must not fire again.
  assert.equal(died, 1);
});

test("rayAABB reports entry distance and face normal", () => {
  const box = { min: new Vector3(-1, -1, -1), max: new Vector3(1, 1, 1) };
  const hit = rayAABB(new Vector3(-10, 0, 0), new Vector3(1, 0, 0), box);
  assert.ok(hit);
  assert.equal(hit.t, 9);
  assert.equal(hit.normal.x, -1);
  assert.equal(rayAABB(new Vector3(-10, 5, 0), new Vector3(1, 0, 0), box), null);
});

test("PhysicsWorld.raycast picks the nearest of parts and terrain", () => {
  const { game, physics } = makeWorld();
  const near = createInstance("Part", game.Workspace);
  near.Anchored = true;
  near.Size = new Vector3(4, 4, 4);
  near.CFrame = CFrame.fromPosition(new Vector3(20, 0, 0));

  const far = createInstance("Part", game.Workspace);
  far.Anchored = true;
  far.Size = new Vector3(4, 4, 4);
  far.CFrame = CFrame.fromPosition(new Vector3(60, 0, 0));

  const hit = physics.raycast(new Vector3(0, 0, 0), new Vector3(1, 0, 0), { maxDistance: 200 });
  assert.equal(hit.instance, near);

  const filtered = physics.raycast(new Vector3(0, 0, 0), new Vector3(1, 0, 0), {
    maxDistance: 200,
    filterDescendantsInstances: [near],
    filterType: "Exclude",
  });
  assert.equal(filtered.instance, far);
});

test("CanQuery=false hides a part from raycasts", () => {
  const { game, physics } = makeWorld();
  const part = createInstance("Part", game.Workspace);
  part.Anchored = true;
  part.CanQuery = false;
  part.CFrame = CFrame.fromPosition(new Vector3(20, 0, 0));
  assert.equal(physics.raycast(new Vector3(0, 0, 0), new Vector3(1, 0, 0), { maxDistance: 100 }), null);
});
