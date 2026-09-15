import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DataModel,
  ReplicaTree,
  Vector3,
  CFrame,
  buildDelta,
  createInstance,
  isEmptyDelta,
} from "../dist/index.js";

/** A server DataModel plus a client mirror wired through the delta pipeline. */
function pair() {
  const server = new DataModel();
  const client = new DataModel();
  client.recordChanges = false;
  const replica = new ReplicaTree(client);
  replica.bindRoot(server.id);
  // Services exist on both sides already; bind them so parents resolve.
  for (const svc of server.GetChildren()) {
    const mirror = client.FindFirstChild(svc.Name);
    if (mirror) replica.byId.set(svc.id, mirror);
  }
  server.flushChanges();
  const sync = () => {
    const delta = buildDelta(server, server.flushChanges());
    if (!isEmptyDelta(delta)) replica.apply(delta);
    return delta;
  };
  return { server, client, replica, sync };
}

test("a new part replicates with its properties", () => {
  const { server, client, sync } = pair();
  const part = createInstance("Part", server.Workspace);
  part.Name = "Brick";
  part.Size = new Vector3(6, 2, 3);
  part.Anchored = true;
  sync();

  const mirror = client.Workspace.FindFirstChild("Brick");
  assert.ok(mirror, "part should exist on the client");
  assert.deepEqual(mirror.Size.toArray(), [6, 2, 3]);
  assert.equal(mirror.Anchored, true);
});

test("property changes replicate as deltas", () => {
  const { server, client, sync } = pair();
  const part = createInstance("Part", server.Workspace);
  part.Name = "Mover";
  sync();

  part.setProperty("CFrame", CFrame.fromPosition(new Vector3(10, 20, 30)));
  const delta = sync();
  assert.ok(delta.set, "expected a property delta");
  assert.deepEqual(
    client.Workspace.FindFirstChild("Mover").CFrame.position.toArray(),
    [10, 20, 30],
  );
});

test("an unchanged tick produces an empty delta", () => {
  const { sync } = pair();
  assert.ok(isEmptyDelta(sync()));
});

test("destroying on the server removes on the client", () => {
  const { server, client, sync } = pair();
  const part = createInstance("Part", server.Workspace);
  part.Name = "Doomed";
  sync();
  assert.ok(client.Workspace.FindFirstChild("Doomed"));
  part.Destroy();
  sync();
  assert.equal(client.Workspace.FindFirstChild("Doomed"), null);
});

test("reparenting replicates", () => {
  const { server, client, sync } = pair();
  const folder = createInstance("Folder", server.Workspace);
  folder.Name = "Box";
  const part = createInstance("Part", server.Workspace);
  part.Name = "Item";
  sync();

  part.Parent = folder;
  sync();
  assert.equal(client.Workspace.FindFirstChild("Item"), null);
  assert.ok(client.Workspace.FindFirstChild("Box").FindFirstChild("Item"));
});

test("a deep subtree arrives parents-first in one packet", () => {
  const { server, client, sync } = pair();
  const model = createInstance("Model", server.Workspace);
  model.Name = "House";
  const room = createInstance("Folder", model);
  room.Name = "Room";
  const part = createInstance("Part", room);
  part.Name = "Wall";
  sync();

  const mirror = client.Workspace.FindFirstChild("House");
  assert.ok(mirror?.FindFirstChild("Room")?.FindFirstChild("Wall"));
});

test("instance references replicate by id", () => {
  const { server, client, sync } = pair();
  const model = createInstance("Model", server.Workspace);
  model.Name = "Rig";
  const part = createInstance("Part", model);
  part.Name = "Core";
  model.setProperty("PrimaryPart", part);
  sync();

  const mirror = client.Workspace.FindFirstChild("Rig");
  assert.equal(mirror.PrimaryPart, mirror.FindFirstChild("Core"));
});

test("an instance created and destroyed in one tick is never sent", () => {
  const { server, sync } = pair();
  const part = createInstance("Part", server.Workspace);
  part.Name = "Ephemeral";
  part.Destroy();
  assert.ok(isEmptyDelta(sync()));
});

test("server Script source is withheld from clients", () => {
  const { server, client, sync } = pair();
  const script = createInstance("Script", server.GetService("ServerScriptService"));
  script.Name = "Secret";
  script.Source = "local apiKey = 'do-not-leak'";
  sync();

  const mirror = client.GetService("ServerScriptService").FindFirstChild("Secret");
  assert.ok(mirror, "the Script instance itself still replicates");
  assert.notEqual(mirror.Source, script.Source);
  assert.equal(mirror.Source, "");
});

test("LocalScript source does reach the client", () => {
  const { server, client, sync } = pair();
  const script = createInstance("LocalScript", server.GetService("StarterPlayer"));
  script.Name = "Controls";
  script.Source = "print('client side')";
  sync();
  assert.equal(
    client.GetService("StarterPlayer").FindFirstChild("Controls").Source,
    "print('client side')",
  );
});

test("out-of-order adds are held until their parent arrives", () => {
  const { server, client, replica } = pair();
  const model = createInstance("Model", server.Workspace);
  model.Name = "Late";
  const part = createInstance("Part", model);
  part.Name = "Child";
  const delta = buildDelta(server, server.flushChanges());

  // Deliver the child first; the tree must buffer it, not drop it.
  const reversed = { add: [...delta.add].reverse() };
  replica.apply(reversed);
  assert.ok(client.Workspace.FindFirstChild("Late")?.FindFirstChild("Child"));
});
