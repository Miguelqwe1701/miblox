#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  CFrame,
  Color3,
  DataModel,
  Vector3,
  createInstance,
  serializePlace,
  type SerializedPlace,
} from "@miblox/core";

/**
 * Builds the starter place.
 *
 * Kept as code rather than a checked-in blob so the demo scripts stay readable
 * and reviewable; run it to regenerate places/baseplate.json.
 */

const SERVER_SCRIPT = `--!strict
-- Runs on the server. This file is the tour of the API.

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Terrain = workspace.Terrain

print("MiBlox starter place is running")

-- Carve a small plateau so there is somewhere flat to land.
Terrain:FillBlock(Vector3.new(0, 20, 0), Vector3.new(96, 8, 96), Enum.Material.Grass)

-- A tower of parts, to show physics and replication doing something visible.
local function buildTower(origin: Vector3, height: number)
	local tower = Instance.new("Model")
	tower.Name = "Tower"
	tower.Parent = workspace

	for i = 1, height do
		local block = Instance.new("Part")
		block.Name = "Block" .. i
		block.Size = Vector3.new(6, 3, 6)
		block.CFrame = CFrame.new(origin + Vector3.new(0, i * 3, 0))
		block.Color = Color3.fromRGB(80 + i * 12, 120, 200 - i * 10)
		block.Material = Enum.Material.Concrete
		block.Anchored = true
		block.Parent = tower
	end
	return tower
end

buildTower(Vector3.new(40, 30, 0), 8)

-- Greet each player and drop a welcome gift they can knock over.
Players.PlayerAdded:Connect(function(player)
	print(player.Name .. " joined")

	player.CharacterAdded:Connect(function(character)
		local humanoid = character:WaitForChild("Humanoid")
		humanoid.WalkSpeed = 18

		local gift = Instance.new("Part")
		gift.Name = "Welcome"
		gift.Size = Vector3.new(4, 4, 4)
		gift.Color = Color3.fromRGB(255, 190, 60)
		gift.Material = Enum.Material.Wood
		gift.CFrame = character:WaitForChild("HumanoidRootPart").CFrame + Vector3.new(0, 24, 0)
		gift.Parent = workspace

		humanoid.Died:Connect(function()
			print(player.Name .. " died; respawning")
			task.wait(Players.RespawnTime)
			player:LoadCharacter()
		end)
	end)
end)

-- A remote the client can call. The server decides what actually happens.
local paintEvent = Instance.new("RemoteEvent")
paintEvent.Name = "Paint"
paintEvent.Parent = ReplicatedStorage

paintEvent.OnServerEvent:Connect(function(player, position, material)
	if typeof(position) ~= "Vector3" then return end
	-- Never trust a client about distance: check it here.
	local character = player.Character
	local root = character and character:FindFirstChild("HumanoidRootPart")
	if not root then return end
	if (root.CFrame.Position - position).Magnitude > 200 then return end

	Terrain:FillBall(position, 8, material or Enum.Material.Rock)
end)

-- A day/night cycle, showing a loop that yields instead of blocking.
task.spawn(function()
	local Lighting = game:GetService("Lighting")
	while true do
		Lighting.ClockTime = (Lighting.ClockTime + 0.05) % 24
		task.wait(1)
	end
end)
`;

const CLIENT_SCRIPT = `--!strict
-- Runs on each player's machine, under StarterPlayerScripts.

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local player = Players.LocalPlayer
print("Hello from the client, " .. player.Name)

local paint = ReplicatedStorage:WaitForChild("Paint")

-- The client asks; the server decides. Sending the position rather than the
-- result is what keeps this honest.
local function paintAt(position: Vector3)
	paint:FireServer(position, Enum.Material.Sand)
end

-- Exposed for the input layer to call on a place-block action.
_G.mibloxPaintAt = paintAt
`;

const MODULE_SCRIPT = `--!strict
-- A shared module, to show require() and cross-script state.

local Settings = {}

Settings.towerHeight = 8
Settings.giftColor = Color3.fromRGB(255, 190, 60)

function Settings.describe(): string
	return \`towers are {Settings.towerHeight} blocks tall\`
end

return Settings
`;

export function buildStarterPlace(): SerializedPlace {
  const game = new DataModel();
  const workspace = game.Workspace;

  game.Terrain.voxels.gen = {
    seed: 20250915,
    seaLevel: 24,
    amplitude: 56,
    scale: 180,
    caves: true,
  };

  const baseplate = createInstance("Part", workspace);
  baseplate.Name = "Baseplate";
  Object.assign(baseplate, {
    Size: new Vector3(512, 16, 512),
    CFrame: CFrame.fromPosition(new Vector3(0, 8, 0)),
    Color: Color3.fromRGB(90, 100, 110),
    Material: "Slate",
    Anchored: true,
  });

  const spawn = createInstance("SpawnLocation", workspace);
  spawn.Name = "SpawnLocation";
  Object.assign(spawn, {
    Size: new Vector3(24, 1, 24),
    CFrame: CFrame.fromPosition(new Vector3(0, 16.5, 0)),
    Color: Color3.fromRGB(70, 160, 90),
    Material: "Concrete",
    Anchored: true,
  });

  // A ramp, so there is something to walk up and test the step solver on.
  for (let i = 0; i < 8; i++) {
    const step = createInstance("Part", workspace);
    step.Name = `Step${i + 1}`;
    Object.assign(step, {
      Size: new Vector3(12, 2, 6),
      CFrame: CFrame.fromPosition(new Vector3(-40, 17 + i * 2, -20 - i * 6)),
      Color: Color3.fromRGB(150, 120, 90),
      Material: "Wood",
      Anchored: true,
    });
  }

  const serverScript = createInstance("Script", game.GetService("ServerScriptService"));
  serverScript.Name = "Main";
  (serverScript as unknown as { Source: string }).Source = SERVER_SCRIPT;

  const clientScript = createInstance(
    "LocalScript",
    game.GetService("StarterPlayer").FindFirstChild("StarterPlayerScripts")!,
  );
  clientScript.Name = "ClientMain";
  (clientScript as unknown as { Source: string }).Source = CLIENT_SCRIPT;

  const settings = createInstance("ModuleScript", game.GetService("ReplicatedStorage"));
  settings.Name = "Settings";
  (settings as unknown as { Source: string }).Source = MODULE_SCRIPT;

  const place = serializePlace(game, "Baseplate");
  return {
    ...place,
    // Extra fields the portal reads when listing games.
    ...({
      description: "An empty world with a spawn, a ramp and a tower. Start here.",
      maxPlayers: 24,
      serverAuthoritative: false,
      tickRate: 30,
    } as Partial<SerializedPlace>),
  };
}

async function main(): Promise<void> {
  const out = resolve(process.argv[2] ?? "places/baseplate.json");
  const place = buildStarterPlace();
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(place, null, 2), "utf8");
  console.log(`wrote ${out}`);
}

// Only run when invoked directly, so tests can import buildStarterPlace.
if (process.argv[1]?.endsWith("build-place.js")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
