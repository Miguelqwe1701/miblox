import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Color3,
  DataModel,
  ReplicaTree,
  UDim2,
  Vector2,
  buildDelta,
  copyStarterGui,
  createInstance,
  deserializePlace,
  isEmptyDelta,
  serializePlace,
} from "../dist/index.js";

function pair() {
  const server = new DataModel();
  const client = new DataModel();
  client.recordChanges = false;
  const replica = new ReplicaTree(client);
  replica.bindRoot(server.id);
  for (const svc of server.GetChildren()) {
    const mirror = client.FindFirstChild(svc.Name);
    if (mirror) replica.byId.set(svc.id, mirror);
  }
  server.flushChanges();
  const sync = () => {
    const delta = buildDelta(server, server.flushChanges());
    if (!isEmptyDelta(delta)) replica.apply(delta);
  };
  return { server, client, sync };
}

/** A StarterGui holding one ScreenGui with a label in it. */
function starterWithLabel(game, { resetOnSpawn = true } = {}) {
  const gui = createInstance("ScreenGui", game.StarterGui ?? game.GetService("StarterGui"));
  gui.Name = "Hud";
  gui.ResetOnSpawn = resetOnSpawn;
  const label = createInstance("TextLabel", gui);
  label.Name = "Coins";
  label.Text = "0";
  label.Position = UDim2.new(0.5, -50, 0, 10);
  label.AnchorPoint = new Vector2(0.5, 0);
  return gui;
}

test("UDim2 resolves scale against the parent and adds offset", () => {
  const u = UDim2.new(0.5, -50, 1, 10);
  assert.equal(u.x.resolve(800), 350);
  assert.equal(u.y.resolve(600), 610);
  assert.deepEqual(u.add(UDim2.fromOffset(5, 5)).toArray(), [0.5, -45, 1, 15]);
  assert.deepEqual(UDim2.fromScale(0, 0).lerp(UDim2.fromScale(1, 1), 0.25).toArray(), [0.25, 0, 0.25, 0]);
});

test("GUI properties survive a place save and load", () => {
  const game = new DataModel();
  starterWithLabel(game);
  const loaded = deserializePlace(JSON.parse(JSON.stringify(serializePlace(game))));
  const label = loaded.GetService("StarterGui").FindFirstChild("Hud").FindFirstChild("Coins");
  assert.ok(label, "label should load");
  assert.deepEqual(label.Position.toArray(), [0.5, -50, 0, 10]);
  assert.equal(label.AnchorPoint.x, 0.5);
  assert.equal(label.Text, "0");
});

test("a player's GUI replicates, and so do later edits to it", () => {
  const { server, client, sync } = pair();
  const player = createInstance("Player", server.Players);
  player.Name = "Ada";
  starterWithLabel(server);
  copyStarterGui(player, server.GetService("StarterGui"));
  sync();

  const mirror = () =>
    client.Players.FindFirstChild("Ada").FindFirstChild("PlayerGui").FindFirstChild("Hud").FindFirstChild("Coins");
  assert.equal(mirror().Text, "0");
  assert.deepEqual(mirror().Position.toArray(), [0.5, -50, 0, 10]);

  const label = player.FindFirstChild("PlayerGui").FindFirstChild("Hud").FindFirstChild("Coins");
  label.setProperty("Text", "25");
  label.setProperty("TextColor3", Color3.fromRGB(255, 200, 0));
  sync();
  assert.equal(mirror().Text, "25");
  assert.equal(mirror().TextColor3.toHex(), 0xffc800);
});

test("a respawn replaces ResetOnSpawn GUIs and leaves the others alone", () => {
  const game = new DataModel();
  const player = createInstance("Player", game.Players);
  const starter = game.GetService("StarterGui");
  starterWithLabel(game, { resetOnSpawn: true }).Name = "Timer";
  starterWithLabel(game, { resetOnSpawn: false }).Name = "Shop";

  const playerGui = copyStarterGui(player, starter);
  const firstTimer = playerGui.FindFirstChild("Timer");
  const firstShop = playerGui.FindFirstChild("Shop");
  firstShop.FindFirstChild("Coins").Text = "bought";

  copyStarterGui(player, starter);
  const timers = playerGui.GetChildren().filter((c) => c.Name === "Timer");
  const shops = playerGui.GetChildren().filter((c) => c.Name === "Shop");
  assert.equal(timers.length, 1);
  assert.notEqual(timers[0], firstTimer, "the timer should be a fresh copy");
  assert.ok(firstTimer.destroyed);
  assert.equal(shops.length, 1);
  assert.equal(shops[0], firstShop, "the shop should be the one given first");
  assert.equal(shops[0].FindFirstChild("Coins").Text, "bought");
});

test("GUI classes report the Roblox class hierarchy", () => {
  const button = createInstance("TextButton");
  assert.ok(button.IsA("GuiButton"));
  assert.ok(button.IsA("GuiObject"));
  assert.ok(!button.IsA("TextLabel"));
  assert.ok(createInstance("Frame").IsA("GuiObject"));
  assert.ok(createInstance("ScreenGui").IsA("LayerCollector"));
});
