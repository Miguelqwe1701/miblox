import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DataModel,
  PhysicsWorld,
  Vector3,
  createInstance,
} from "@miblox/core";
import { ScriptEnvironment } from "../dist/api/environment.js";

/** A server-side script environment over a fresh, empty world. */
function makeEnv(overrides = {}) {
  const game = new DataModel();
  game.Terrain.voxels.generateOnAccess = false;
  const physics = new PhysicsWorld(game.Workspace, game.Terrain.voxels);
  const prints = [];
  const errors = [];
  const env = new ScriptEnvironment({
    game,
    physics,
    side: "server",
    onPrint: (text) => prints.push(text),
    onError: (message) => errors.push(message),
    ...overrides,
  });
  return { game, physics, env, prints, errors };
}

/** Compiles and runs a chunk to completion, returning printed output. */
function runScript(env, source, name = "Test") {
  const script = createInstance("Script", env.game.GetService("ServerScriptService"));
  script.Name = name;
  script.Source = source;
  env.env.runScript(script);
  env.env.vm.scheduler.drain();
  return env;
}

test("a script can create and configure parts", () => {
  const ctx = makeEnv();
  runScript(
    ctx,
    `
      local part = Instance.new("Part")
      part.Name = "Platform"
      part.Size = Vector3.new(10, 2, 10)
      part.Anchored = true
      part.Color = Color3.fromRGB(255, 0, 0)
      part.Material = Enum.Material.Wood
      part.Parent = workspace
    `,
  );
  assert.deepEqual(ctx.errors, []);
  const part = ctx.game.Workspace.FindFirstChild("Platform");
  assert.ok(part, "the part should exist in the world");
  assert.deepEqual(part.Size.toArray(), [10, 2, 10]);
  assert.equal(part.Anchored, true);
  assert.equal(part.Material, "Wood");
  assert.equal(part.Color.toHex(), 0xff0000);
});

test("property writes go through the replication journal", () => {
  const ctx = makeEnv();
  const part = createInstance("Part", ctx.game.Workspace);
  part.Name = "Target";
  ctx.game.flushChanges();

  runScript(ctx, `workspace.Target.Transparency = 0.5`);
  const changes = ctx.game.flushChanges();
  const changed = changes.props.find(([id]) => id === part.id);
  assert.ok(changed, "the write should have been journalled for replication");
  assert.ok(changed[1].includes("Transparency"));
  assert.equal(part.Transparency, 0.5);
});

test("children are reachable by name and by method", () => {
  const ctx = makeEnv();
  const folder = createInstance("Folder", ctx.game.Workspace);
  folder.Name = "Props";
  const part = createInstance("Part", folder);
  part.Name = "Crate";

  runScript(
    ctx,
    `
      print(workspace.Props.Crate.Name)
      print(workspace:FindFirstChild("Props"):FindFirstChild("Crate").ClassName)
      print(#workspace.Props:GetChildren())
    `,
  );
  assert.deepEqual(ctx.errors, []);
  assert.deepEqual(ctx.prints, ["Crate", "Part", "1"]);
});

test("reading a member that does not exist is an error, not nil", () => {
  const ctx = makeEnv();
  runScript(ctx, `local x = workspace.NoSuchThing`);
  assert.equal(ctx.errors.length, 1);
  assert.match(ctx.errors[0], /not a valid member/);
});

test("Vector3 and CFrame arithmetic works from Luau", () => {
  const ctx = makeEnv();
  runScript(
    ctx,
    `
      local a = Vector3.new(1, 2, 3)
      local b = Vector3.new(4, 5, 6)
      print((a + b).X, (b - a).Y, (a * 2).Z)
      print(a:Dot(b))
      print(tostring(a.Unit.Magnitude))
      local cf = CFrame.new(Vector3.new(0, 10, 0))
      print((cf + Vector3.new(0, 5, 0)).Position.Y)
      print(typeof(a), typeof(cf))
    `,
  );
  assert.deepEqual(ctx.errors, []);
  assert.deepEqual(ctx.prints, ["5\t3\t6", "32", "1", "15", "Vector3\tCFrame"]);
});

test("instance equality compares the underlying instance", () => {
  const ctx = makeEnv();
  const part = createInstance("Part", ctx.game.Workspace);
  part.Name = "Same";
  runScript(
    ctx,
    `
      local a = workspace.Same
      local b = workspace:FindFirstChild("Same")
      print(a == b, a == workspace)
    `,
  );
  assert.deepEqual(ctx.prints, ["true\tfalse"]);
});

test("events fire script handlers on their own thread", () => {
  const ctx = makeEnv();
  runScript(
    ctx,
    `
      workspace.ChildAdded:Connect(function(child)
        print("added " .. child.Name)
      end)
    `,
  );
  const part = createInstance("Part");
  part.Name = "Latecomer";
  part.Parent = ctx.game.Workspace;
  ctx.env.vm.scheduler.drain();
  assert.deepEqual(ctx.prints, ["added Latecomer"]);
});

test("a handler that yields does not block the engine", () => {
  const ctx = makeEnv();
  runScript(
    ctx,
    `
      workspace.ChildAdded:Connect(function(child)
        task.wait(0.05)
        print("handled " .. child.Name)
      end)
    `,
  );
  const part = createInstance("Part");
  part.Name = "Slow";
  part.Parent = ctx.game.Workspace;
  // The fire itself returns immediately; the handler completes later.
  assert.deepEqual(ctx.prints, []);
  ctx.env.vm.scheduler.drain();
  assert.deepEqual(ctx.prints, ["handled Slow"]);
});

test("GetPropertyChangedSignal fires for script writes", () => {
  const ctx = makeEnv();
  const part = createInstance("Part", ctx.game.Workspace);
  part.Name = "Watched";
  runScript(
    ctx,
    `
      local part = workspace.Watched
      part:GetPropertyChangedSignal("Transparency"):Connect(function()
        print("transparency is now " .. tostring(part.Transparency))
      end)
      part.Transparency = 0.25
    `,
  );
  ctx.env.vm.scheduler.drain();
  assert.deepEqual(ctx.prints, ["transparency is now 0.25"]);
});

test("WaitForChild yields until the child appears", () => {
  const ctx = makeEnv();
  runScript(
    ctx,
    `
      local later = workspace:WaitForChild("Later")
      print("found " .. later.Name)
    `,
  );
  assert.deepEqual(ctx.prints, [], "should still be waiting");
  const part = createInstance("Part");
  part.Name = "Later";
  part.Parent = ctx.game.Workspace;
  // WaitForChild resolves through a promise, so let microtasks run first.
  return new Promise((resolve) => setImmediate(resolve)).then(() => {
    ctx.env.vm.scheduler.drain();
    assert.deepEqual(ctx.prints, ["found Later"]);
  });
});

test("require runs a module once and caches its result", () => {
  const ctx = makeEnv();
  const module = createInstance("ModuleScript", ctx.game.GetService("ReplicatedStorage"));
  module.Name = "Counter";
  module.Source = `
    print("module body ran")
    local m = {n = 0}
    function m.bump() m.n = m.n + 1 return m.n end
    return m
  `;
  runScript(
    ctx,
    `
      local Counter = require(game:GetService("ReplicatedStorage").Counter)
      local Again = require(game:GetService("ReplicatedStorage").Counter)
      print(Counter.bump(), Again.bump(), Counter == Again)
    `,
  );
  assert.deepEqual(ctx.errors, []);
  assert.deepEqual(ctx.prints, ["module body ran", "1\t2\ttrue"]);
});

test("a module that requires itself reports a cycle", () => {
  const ctx = makeEnv();
  const module = createInstance("ModuleScript", ctx.game.GetService("ReplicatedStorage"));
  module.Name = "Cyclic";
  module.Source = `return require(game:GetService("ReplicatedStorage").Cyclic)`;
  runScript(ctx, `require(game:GetService("ReplicatedStorage").Cyclic)`);
  assert.equal(ctx.errors.length, 1);
  assert.match(ctx.errors[0], /requires itself/);
});

test("terrain can be edited from a script", () => {
  const ctx = makeEnv();
  runScript(
    ctx,
    `
      local Terrain = workspace.Terrain
      Terrain:FillBlock(Vector3.new(0, 0, 0), Vector3.new(32, 8, 32), Enum.Material.Grass)
      print(Terrain:GetVoxel(0, 0, 0))
    `,
  );
  assert.deepEqual(ctx.errors, []);
  assert.notEqual(ctx.prints[0], "0", "the voxel should no longer be air");
  assert.equal(ctx.game.Terrain.GetVoxel(0, 0, 0), 1);
});

test("workspace:Raycast reaches the physics engine", () => {
  const ctx = makeEnv();
  const wall = createInstance("Part", ctx.game.Workspace);
  wall.Name = "Wall";
  wall.Anchored = true;
  wall.Size = new Vector3(4, 20, 20);
  wall.CFrame = createInstance("Part").CFrame.add(new Vector3(30, 0, 0));

  runScript(
    ctx,
    `
      local hit = workspace:Raycast(Vector3.new(0, 0, 0), Vector3.new(100, 0, 0))
      print(hit ~= nil, hit and hit.Instance.Name, math.floor(hit.Distance))
    `,
  );
  assert.deepEqual(ctx.errors, []);
  assert.deepEqual(ctx.prints, ["true\tWall\t28"]);
});

test("a script error names the script and line", () => {
  const ctx = makeEnv();
  runScript(ctx, `local x = 1\nerror("something broke")`, "Breaker");
  assert.equal(ctx.errors.length, 1);
  assert.match(ctx.errors[0], /something broke/);
  assert.match(ctx.errors[0], /Breaker/);
});

test("a syntax error is reported without crashing the environment", () => {
  const ctx = makeEnv();
  runScript(ctx, `local x = = 1`, "Broken");
  assert.equal(ctx.errors.length, 1);
  assert.match(ctx.errors[0], /Broken/);
  // The environment still works afterwards.
  runScript(ctx, `print("still alive")`, "Fine");
  assert.deepEqual(ctx.prints, ["still alive"]);
});

test("a runaway script is stopped without taking the server with it", () => {
  const ctx = makeEnv({ maxSteps: 50000 });
  runScript(ctx, `while true do end`, "Runaway");
  assert.equal(ctx.errors.length, 1);
  assert.match(ctx.errors[0], /exceeded/);
  runScript(ctx, `print("server is fine")`, "After");
  assert.deepEqual(ctx.prints, ["server is fine"]);
});

test("FireServer is refused on the server side", () => {
  const ctx = makeEnv();
  const remote = createInstance("RemoteEvent", ctx.game.GetService("ReplicatedStorage"));
  remote.Name = "Ping";
  runScript(ctx, `game:GetService("ReplicatedStorage").Ping:FireServer()`);
  assert.equal(ctx.errors.length, 1);
  assert.match(ctx.errors[0], /only be called from a client/);
});

test("scripts cannot reassign the frozen libraries", () => {
  const ctx = makeEnv();
  runScript(ctx, `Vector3.new = function() return nil end`);
  assert.equal(ctx.errors.length, 1);
  assert.match(ctx.errors[0], /readonly/);
});

test("Enum values assign cleanly to properties", () => {
  const ctx = makeEnv();
  runScript(
    ctx,
    `
      local p = Instance.new("Part", workspace)
      p.Name = "Enumed"
      p.Material = Enum.Material.Ice
      print(p.Material == Enum.Material.Ice)
    `,
  );
  assert.deepEqual(ctx.prints, ["true"]);
  assert.equal(ctx.game.Workspace.FindFirstChild("Enumed").Material, "Ice");
});

test("Instance.new refuses an unknown class", () => {
  const ctx = makeEnv();
  runScript(ctx, `Instance.new("NotAThing")`);
  assert.equal(ctx.errors.length, 1);
  assert.match(ctx.errors[0], /Unable to create an Instance/);
});
