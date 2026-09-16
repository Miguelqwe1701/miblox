import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DataModel,
  Vector3,
  createInstance,
  serializePlace,
  deserializePlace,
  buildCharacter,
  ReplicaTree,
  buildDelta,
} from "../dist/index.js";

test("children track parenting both ways", () => {
  const game = new DataModel();
  const folder = createInstance("Folder", game.Workspace);
  folder.Name = "Stuff";
  assert.equal(game.Workspace.FindFirstChild("Stuff"), folder);
  folder.Parent = null;
  assert.equal(game.Workspace.FindFirstChild("Stuff"), null);
});

test("ChildAdded and ChildRemoved fire", () => {
  const game = new DataModel();
  const seen = [];
  game.Workspace.ChildAdded.Connect((c) => seen.push(`+${c.Name}`));
  game.Workspace.ChildRemoved.Connect((c) => seen.push(`-${c.Name}`));
  const part = createInstance("Part");
  part.Name = "Brick";
  part.Parent = game.Workspace;
  part.Parent = null;
  assert.deepEqual(seen, ["+Brick", "-Brick"]);
});

test("a circular parent is rejected", () => {
  const a = createInstance("Folder");
  const b = createInstance("Folder", a);
  assert.throws(() => (a.Parent = b), /circular/);
  assert.throws(() => (a.Parent = a), /own Parent/);
});

test("IsA walks the class hierarchy", () => {
  const part = createInstance("Part");
  assert.ok(part.IsA("Part"));
  assert.ok(part.IsA("BasePart"));
  assert.ok(part.IsA("Instance"));
  assert.ok(!part.IsA("Model"));
});

test("Destroy tears down descendants", () => {
  const game = new DataModel();
  const model = createInstance("Model", game.Workspace);
  const part = createInstance("Part", model);
  model.Destroy();
  assert.ok(model.destroyed);
  assert.ok(part.destroyed);
  assert.equal(game.byId.has(part.id), false);
});

test("GetPropertyChangedSignal fires on setProperty", () => {
  const part = createInstance("Part");
  let fired = 0;
  part.GetPropertyChangedSignal("Transparency").Connect(() => fired++);
  part.setProperty("Transparency", 0.5);
  part.setProperty("Transparency", 0.5); // No change, so no second fire.
  assert.equal(fired, 1);
});

test("Clone copies properties and children", () => {
  const model = createInstance("Model");
  const part = createInstance("Part", model);
  part.Size = new Vector3(8, 8, 8);
  const copy = model.Clone();
  const copiedPart = copy.FindFirstChildOfClass("Part");
  assert.deepEqual(copiedPart.Size.toArray(), [8, 8, 8]);
  assert.notEqual(copiedPart, part);
});

test("GetFullName reports the path below the DataModel", () => {
  const game = new DataModel();
  const model = createInstance("Model", game.Workspace);
  model.Name = "House";
  const part = createInstance("Part", model);
  part.Name = "Door";
  assert.equal(part.GetFullName(), "Workspace.House.Door");
});

test("WaitForChild resolves when the child appears", async () => {
  const game = new DataModel();
  const promise = game.Workspace.WaitForChild("Later", 1);
  const part = createInstance("Part");
  part.Name = "Later";
  part.Parent = game.Workspace;
  assert.equal(await promise, part);
});

test("place files round-trip through serialization", () => {
  const game = new DataModel();
  const part = createInstance("Part", game.Workspace);
  part.Name = "Baseplate";
  part.Size = new Vector3(512, 16, 512);
  part.Anchored = true;
  const script = createInstance("Script", game.GetService("ServerScriptService"));
  script.Name = "Main";
  script.Source = "print('hello')";
  game.Terrain.SetVoxel(0, 0, 0, 2);

  const place = serializePlace(game, "Test");
  const restored = deserializePlace(JSON.parse(JSON.stringify(place)));

  const rPart = restored.Workspace.FindFirstChild("Baseplate");
  assert.equal(rPart.Size.x, 512);
  assert.equal(rPart.Anchored, true);
  assert.equal(
    restored.GetService("ServerScriptService").FindFirstChild("Main").Source,
    "print('hello')",
  );
  assert.equal(restored.Terrain.GetVoxel(0, 0, 0), 2);
});

test("the placeholder character rig has what physics needs", () => {
  const model = buildCharacter({ position: new Vector3(0, 20, 0) });
  assert.ok(model.FindFirstChildOfClass("Humanoid"));
  const root = model.FindFirstChild("HumanoidRootPart");
  assert.ok(root);
  assert.equal(root.CFrame.position.y, 20);
  for (const name of ["Head", "Torso", "Left Arm", "Right Arm", "Left Leg", "Right Leg"]) {
    assert.ok(model.FindFirstChild(name), `missing ${name}`);
  }
});

test("serializing does not duplicate Terrain on reload", () => {
  const game = new DataModel();
  game.Terrain.SetVoxel(0, 0, 0, 2);

  // Round-trip twice: a duplicate would compound with each save.
  let place = serializePlace(game, "Round");
  let restored = deserializePlace(JSON.parse(JSON.stringify(place)));
  place = serializePlace(restored, "Round");
  restored = deserializePlace(JSON.parse(JSON.stringify(place)));

  const terrains = restored.Workspace.GetChildren().filter((c) => c.className === "Terrain");
  assert.equal(terrains.length, 1, "exactly one Terrain should exist");
  assert.equal(restored.Workspace.Terrain, terrains[0], "and it must be the live one");
  assert.equal(restored.Terrain.GetVoxel(0, 0, 0), 2, "its voxels should survive");
  // The Camera is not written to the file, but a fresh DataModel makes its
  // own, so the property that matters is that there is exactly one.
  assert.equal(
    restored.Workspace.GetChildren().filter((c) => c.className === "Camera").length,
    1,
    "the Camera should not be duplicated either",
  );
  const savedWorkspaceChildren =
    place.services.find((s) => s.name === "Workspace")?.children ?? [];
  assert.equal(
    savedWorkspaceChildren.some((c) => c.className === "Camera" || c.className === "Terrain"),
    false,
    "neither should be written into the place file",
  );
});

test("auto-created containers are reused, not duplicated, on load", () => {
  const game = new DataModel();
  const starterPlayer = game.GetService("StarterPlayer");
  const container = starterPlayer.FindFirstChild("StarterPlayerScripts");
  const script = createInstance("LocalScript", container);
  script.Name = "ClientMain";
  script.Source = "print('client')";

  const restored = deserializePlace(JSON.parse(JSON.stringify(serializePlace(game, "Round"))));
  const restoredStarter = restored.GetService("StarterPlayer");
  const containers = restoredStarter
    .GetChildren()
    .filter((c) => c.className === "StarterPlayerScripts");

  assert.equal(containers.length, 1, "a second StarterPlayerScripts would shadow the real one");
  // The lookup the client actually performs must find the scripts.
  const found = restoredStarter.FindFirstChild("StarterPlayerScripts");
  assert.equal(found.FindFirstChild("ClientMain")?.Source, "print('client')");
});

test("replication also adopts auto-created containers", () => {
  const server = new DataModel();
  const container = server.GetService("StarterPlayer").FindFirstChild("StarterPlayerScripts");
  const script = createInstance("LocalScript", container);
  script.Name = "ClientMain";
  script.Source = "print('client')";

  const client = new DataModel();
  client.recordChanges = false;
  const replica = new ReplicaTree(client);
  replica.bindRoot(server.id);
  replica.apply(buildDelta(server, server.flushChanges()));

  const starter = client.GetService("StarterPlayer");
  assert.equal(
    starter.GetChildren().filter((c) => c.className === "StarterPlayerScripts").length,
    1,
  );
  assert.equal(
    starter.FindFirstChild("StarterPlayerScripts").FindFirstChild("ClientMain")?.Source,
    "print('client')",
  );
});
