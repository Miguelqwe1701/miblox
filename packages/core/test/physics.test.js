import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DataModel,
  PhysicsWorld,
  Vector3,
  CFrame,
  createInstance,
  buildCharacter,
  loadCharacterFor,
  buildAvatar,
  Color3,
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

test("simulationFilter skips bodies another machine owns", () => {
  const { game, physics } = makeWorld();
  const mine = createInstance("Part", game.Workspace);
  mine.CFrame = CFrame.fromPosition(new Vector3(0, 100, 0));
  const theirs = createInstance("Part", game.Workspace);
  theirs.NetworkOwnerId = "someone-else";
  theirs.CFrame = CFrame.fromPosition(new Vector3(20, 100, 0));

  physics.simulationFilter = (part) => part.NetworkOwnerId === "";
  simulate(physics, 0.5);

  assert.ok(mine.CFrame.position.y < 100, "an owned part should fall");
  assert.equal(theirs.CFrame.position.y, 100, "a part owned elsewhere must not be integrated");
});

test("an unowned character is left to its owner to simulate", () => {
  const { game, physics } = makeWorld();
  const char = buildCharacter({ position: new Vector3(0, 50, 0) });
  char.Parent = game.Workspace;
  const root = char.FindFirstChild("HumanoidRootPart");
  root.NetworkOwnerId = "player-1";
  physics.simulationFilter = (part) => part.NetworkOwnerId === "";

  simulate(physics, 0.5);
  assert.equal(root.CFrame.position.y, 50);
});

test("parts owned elsewhere still collide with what we do simulate", () => {
  const { game, physics } = makeWorld();
  const platform = createInstance("Part", game.Workspace);
  platform.NetworkOwnerId = "someone-else";
  platform.Size = new Vector3(20, 4, 20);
  platform.CFrame = CFrame.fromPosition(Vector3.zero);

  const box = createInstance("Part", game.Workspace);
  box.Size = new Vector3(2, 2, 2);
  box.CFrame = CFrame.fromPosition(new Vector3(0, 40, 0));

  physics.simulationFilter = (part) => part.NetworkOwnerId === "";
  simulate(physics, 4);
  assert.ok(
    box.CFrame.position.y > 2,
    `should rest on the other machine's platform, got ${box.CFrame.position.y}`,
  );
});

// ---------------------------------------------------------------------------
// Characters: the placeholder rig, custom rigs, and NPCs
// ---------------------------------------------------------------------------

test("loadCharacterFor falls back to the placeholder rig", () => {
  const game = new DataModel();
  const { model, custom } = loadCharacterFor(game.GetService("StarterPlayer"), {
    position: new Vector3(0, 20, 0),
  });
  assert.equal(custom, false);
  assert.ok(model.FindFirstChildOfClass("Humanoid"));
  assert.ok(model.FindFirstChild("HumanoidRootPart"));
});

test("a StarterCharacter model is used instead of the placeholder", () => {
  const game = new DataModel();
  const starterPlayer = game.GetService("StarterPlayer");

  // A minimal custom rig: the engine only requires these two things.
  const template = createInstance("Model", starterPlayer);
  template.Name = "StarterCharacter";
  const root = createInstance("Part", template);
  root.Name = "HumanoidRootPart";
  root.Size = new Vector3(3, 6, 3);
  const body = createInstance("Part", template);
  body.Name = "CustomBody";
  body.Color = Color3.fromRGB(255, 0, 128);
  createInstance("Humanoid", template);

  const { model, custom } = loadCharacterFor(starterPlayer, {
    name: "Tester",
    position: new Vector3(40, 30, -10),
  });

  assert.equal(custom, true, "the place's rig should have been used");
  assert.equal(model.Name, "Tester");
  assert.ok(model.FindFirstChild("CustomBody"), "the custom parts should come along");
  assert.notEqual(model, template, "the template itself must not be reparented");
  assert.ok(starterPlayer.FindFirstChild("StarterCharacter"), "the template stays put");

  const spawnedRoot = model.FindFirstChild("HumanoidRootPart");
  assert.ok(Math.abs(spawnedRoot.CFrame.position.x - 40) < 8, "it should move to the spawn");
});

test("a StarterCharacter without a Humanoid is rejected", () => {
  const game = new DataModel();
  const starterPlayer = game.GetService("StarterPlayer");
  const broken = createInstance("Model", starterPlayer);
  broken.Name = "StarterCharacter";
  createInstance("Part", broken).Name = "HumanoidRootPart";

  // No Humanoid means the engine cannot drive it, so fall back rather than
  // spawn something that will never move.
  const { custom, model } = loadCharacterFor(starterPlayer);
  assert.equal(custom, false);
  assert.ok(model.FindFirstChildOfClass("Humanoid"));
});

test("StarterCharacterScripts are copied into the character", () => {
  const game = new DataModel();
  const starterPlayer = game.GetService("StarterPlayer");
  const container = starterPlayer.FindFirstChild("StarterCharacterScripts");
  const script = createInstance("LocalScript", container);
  script.Name = "Controller";
  script.Source = "print('hi')";

  const { model } = loadCharacterFor(starterPlayer);
  const copied = model.FindFirstChild("Controller");
  assert.ok(copied, "the script should be copied into the character");
  assert.notEqual(copied, script, "and it should be a copy, not the original");
  assert.equal(copied.Source, "print('hi')");
});

test("any model with a Humanoid is simulated, so NPCs just work", () => {
  const { game, physics } = makeWorld();
  const floor = createInstance("Part", game.Workspace);
  floor.Anchored = true;
  floor.Size = new Vector3(200, 4, 200);
  floor.CFrame = CFrame.fromPosition(Vector3.zero);

  // Built by hand, the way a script would build an NPC.
  const npc = createInstance("Model", game.Workspace);
  npc.Name = "Shopkeeper";
  const root = createInstance("Part", npc);
  root.Name = "HumanoidRootPart";
  root.Size = new Vector3(2, 2, 1);
  root.CFrame = CFrame.fromPosition(new Vector3(0, 30, 0));
  npc.PrimaryPart = root;
  const humanoid = createInstance("Humanoid", npc);

  simulate(physics, 2);
  assert.ok(root.CFrame.position.y < 30, "the NPC should fall under gravity");
  const restY = root.CFrame.position.y;

  humanoid.MoveDirection = new Vector3(0, 0, -1);
  simulate(physics, 1);
  assert.ok(root.CFrame.position.z < -5, "and walk when told to");
  assert.ok(Math.abs(root.CFrame.position.y - restY) < 1.5, "staying on the floor");
});

test("a player's character can be swapped for another model", () => {
  const game = new DataModel();
  const player = createInstance("Player", game.Players);
  player.Name = "Swapper";

  const first = loadCharacterFor(game.GetService("StarterPlayer")).model;
  first.Parent = game.Workspace;
  player.setProperty("Character", first);
  assert.equal(player.Character, first);

  const replacement = createInstance("Model", game.Workspace);
  replacement.Name = "NewBody";
  createInstance("Humanoid", replacement);
  const root = createInstance("Part", replacement);
  root.Name = "HumanoidRootPart";

  player.setProperty("Character", replacement);
  assert.equal(player.Character, replacement);
  assert.equal(game.Players.GetPlayerFromCharacter(replacement), player);
  assert.equal(game.Players.GetPlayerFromCharacter(first), null);
});

// ---------------------------------------------------------------------------
// A character rests on its feet, not its hips
// ---------------------------------------------------------------------------

/** Lowest point of any part in a character, in world space. */
function soles(character) {
  let lowest = Infinity;
  for (const part of character.GetDescendants()) {
    if (!part.Size) continue;
    lowest = Math.min(lowest, part.CFrame.position.y - part.Size.y / 2);
  }
  return lowest;
}

test("a character stands on its feet rather than sinking to the hips", () => {
  const { game, physics } = makeWorld();
  const floor = createInstance("Part", game.Workspace);
  floor.Anchored = true;
  floor.Size = new Vector3(200, 4, 200);
  floor.CFrame = CFrame.fromPosition(Vector3.zero);
  const floorTop = 2;

  const char = buildCharacter({ position: new Vector3(0, 40, 0) });
  char.Parent = game.Workspace;
  simulate(physics, 4);

  // Only the root collides, but the legs hang two studs below it. Without hip
  // height the root rests on the floor and the legs end up buried.
  const feet = soles(char);
  assert.ok(
    Math.abs(feet - floorTop) < 0.75,
    `feet should rest on the floor at y=${floorTop}, got ${feet.toFixed(2)}`,
  );

  const root = char.FindFirstChild("HumanoidRootPart");
  assert.ok(
    root.CFrame.position.y > floorTop + 2,
    `the root should be well above the floor, got ${root.CFrame.position.y.toFixed(2)}`,
  );
});

test("a character stands on voxel terrain at the right height too", () => {
  const { game, physics } = makeWorld();
  for (let x = -3; x <= 3; x++) {
    for (let z = -3; z <= 3; z++) game.Terrain.SetVoxel(x, 0, z, MATERIAL_ID.Rock);
  }
  const groundTop = 4; // one voxel, 4 studs tall

  const char = buildCharacter({ position: new Vector3(2, 40, 2) });
  char.Parent = game.Workspace;
  simulate(physics, 4);

  const feet = soles(char);
  assert.ok(
    Math.abs(feet - groundTop) < 0.75,
    `feet should rest on terrain at y=${groundTop}, got ${feet.toFixed(2)}`,
  );
});

test("a scaled character's hip height scales with it", () => {
  const { game, physics } = makeWorld();
  const floor = createInstance("Part", game.Workspace);
  floor.Anchored = true;
  floor.Size = new Vector3(200, 4, 200);
  floor.CFrame = CFrame.fromPosition(Vector3.zero);

  const tall = buildAvatar({ heightScale: 1.5 }, { position: new Vector3(0, 40, 0) });
  tall.Parent = game.Workspace;
  const humanoid = tall.FindFirstChildOfClass("Humanoid");
  assert.ok(humanoid.HipHeight > 2, "a taller rig has further to reach");

  simulate(physics, 4);
  const feet = soles(tall);
  assert.ok(
    Math.abs(feet - 2) < 0.9,
    `a scaled character should also stand on the floor, got ${feet.toFixed(2)}`,
  );
});

test("walking keeps the feet on the ground", () => {
  const { game, physics } = makeWorld();
  const floor = createInstance("Part", game.Workspace);
  floor.Anchored = true;
  floor.Size = new Vector3(400, 4, 400);
  floor.CFrame = CFrame.fromPosition(Vector3.zero);

  const char = buildCharacter({ position: new Vector3(0, 20, 0) });
  char.Parent = game.Workspace;
  simulate(physics, 2);
  const restingFeet = soles(char);

  char.FindFirstChildOfClass("Humanoid").MoveDirection = new Vector3(1, 0, 0);
  simulate(physics, 1.5);

  assert.ok(char.FindFirstChild("HumanoidRootPart").CFrame.position.x > 5, "should have walked");
  assert.ok(
    Math.abs(soles(char) - restingFeet) < 0.6,
    "and stayed at the same height while walking",
  );
});
