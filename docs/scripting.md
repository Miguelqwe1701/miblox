# Scripting MiBlox

Places are scripted in Luau. The same interpreter runs on the server and in
every client, so there is one language and one API surface to learn.

## Where scripts run

| Class | Runs | Gets |
| --- | --- | --- |
| `Script` | on the server | `FireClient`, `FireAllClients`, authority over the world |
| `LocalScript` | on each player's machine | `FireServer`, `Players.LocalPlayer` |
| `ModuleScript` | wherever it is required | returns a value, run once and cached |

A `Script` under `ServerScriptService`, `Workspace` or `ReplicatedStorage`
runs when the world starts. A `LocalScript` under
`StarterPlayer.StarterPlayerScripts` runs on each client that joins, one
under `StarterCharacterScripts` is copied into every character, and one inside
a GUI in `StarterGui` runs on each client from its copy in that player's
`PlayerGui`. Destroying a script stops it.

Server script source is never sent to clients. `LocalScript` and
`ModuleScript` source is, because it has to be.

## Threads

Every event handler runs on its own thread, so a handler that yields cannot
block the engine code that fired it:

```lua
workspace.ChildAdded:Connect(function(child)
	task.wait(1)          -- does not hold anything up
	print(child.Name .. " has been here a second")
end)
```

A script that loops without yielding is stopped with an error rather than
hanging the world, so `while true do end` costs one script, not one server.
The budget is per resume, so a loop that waits each pass runs forever quite
happily:

```lua
while true do
	step()
	task.wait()           -- resumes next frame
end
```

## The API

### Values

`Vector3`, `Vector2`, `CFrame`, `Color3`, `UDim` and `UDim2`, with the
operators you expect:

```lua
local a = Vector3.new(1, 2, 3) + Vector3.new(4, 5, 6)
local spin = CFrame.new(0, 10, 0) * CFrame.Angles(0, math.pi / 2, 0)
local look = CFrame.lookAt(Vector3.zero, Vector3.new(0, 0, -10))
local colour = Color3.fromRGB(90, 169, 255)
```

### Instances

```lua
local part = Instance.new("Part")
part.Size = Vector3.new(8, 2, 8)
part.Material = Enum.Material.Slate
part.Anchored = true
part.Parent = workspace

workspace.SomePart.Touched:Connect(function(other) ... end)
local thing = workspace:WaitForChild("Thing", 5)
part:GetPropertyChangedSignal("Transparency"):Connect(...)
```

Members resolve in Roblox's order: methods, then properties, then children by
name. Reading a member that does not exist is an error, not `nil`, which
catches a typo where it happens rather than three lines later.

### Terrain

```lua
local Terrain = workspace.Terrain
Terrain:FillBlock(Vector3.new(0, 10, 0), Vector3.new(120, 12, 120), Enum.Material.Grass)
Terrain:FillBall(Vector3.new(0, 30, 0), 16, Enum.TerrainMaterial.Air)  -- carve
print(Terrain:GetSurfaceHeight(0, 0))
```

`Enum.TerrainMaterial.Air` is how you clear a region, which is the only way to
carve space out of procedurally generated ground.

### Raycasting

```lua
local hit = workspace:Raycast(origin, direction * 200, {
	FilterDescendantsInstances = { character },
	FilterType = "Exclude",
})
if hit then print(hit.Instance, hit.Position, hit.Material) end
```

### Characters and avatars

Any model with a `Humanoid` and a part named `HumanoidRootPart` is simulated,
so an NPC needs no special support:

```lua
local npc = Instance.new("Model")
npc.Name = "Shopkeeper"
local root = Instance.new("Part")
root.Name = "HumanoidRootPart"
root.Parent = npc
Instance.new("Humanoid").Parent = npc
npc.Parent = workspace
```

Appearance is a `HumanoidDescription` — catalogue ids rather than URLs:

```lua
local look = Instance.new("HumanoidDescription")
look.Shirt = 1005
look.Pants = 2004
look.HatAccessory = "4001,4003"    -- comma-separated, like Roblox
look.HairAccessory = "5003"
look.HeadColor = Color3.fromRGB(243, 217, 164)
look.HeightScale = 1.1

local model = Players:CreateHumanoidModelFromDescription(look)
model.Parent = workspace

-- Or re-dress someone in place, without respawning them:
character:FindFirstChildOfClass("Humanoid"):ApplyDescription(look)
```

A place can ship its own rig as a `Model` named `StarterCharacter` under
`StarterPlayer`, and it is cloned for each player instead of the default.

### GUIs

`ScreenGui`, `Frame`, `TextLabel`, `TextButton` and `ImageLabel`, laid out with
`UDim2` the way Roblox lays them out: scale is a fraction of the parent, offset
is pixels, and `AnchorPoint` says which point of the object sits at
`Position`.

Put a `ScreenGui` in `StarterGui` and every player gets a copy in their
`PlayerGui` each time their character spawns. A `ScreenGui` with
`ResetOnSpawn = false` is given once and kept, so its state survives dying. A
`LocalScript` inside it runs on that player's client:

```lua
-- LocalScript inside StarterGui.ShopGui
local panel = script.Parent.Panel
local buy = game:GetService("ReplicatedStorage"):WaitForChild("Buy")

panel.BuyButton.MouseButton1Click:Connect(function()
	buy:FireServer("Sword")
end)
```

Clicks happen on the client that clicked, as in Roblox, so tell the server
with a `RemoteEvent`. A server `Script` can edit a player's GUI directly,
through `player.PlayerGui`, and the change replicates:

```lua
player.PlayerGui.ShopGui.Panel.Coins.Text = "Coins: " .. coins
```

The mouse is captured for the camera once you click the world. Press **Alt**
to free it and click a button, or set `Modal = true` on a button to keep the
mouse free while that button is on screen. A `LocalScript` can also build a GUI
with `Instance.new`; that GUI exists only on that client.

### Remotes

```lua
-- server
local remote = Instance.new("RemoteEvent")
remote.Name = "Paint"
remote.Parent = game:GetService("ReplicatedStorage")

remote.OnServerEvent:Connect(function(player, position)
	-- Never trust a client about distance: check it here.
	local root = player.Character and player.Character:FindFirstChild("HumanoidRootPart")
	if not root or (root.CFrame.Position - position).Magnitude > 200 then return end
	workspace.Terrain:FillBall(position, 8, Enum.Material.Rock)
end)

-- client
game:GetService("ReplicatedStorage"):WaitForChild("Paint"):FireServer(position)
```

## What is not there

Honest list, so nothing surprises you:

- **More GUI.** No `ScrollingFrame`, `TextBox`, `ImageButton`, layouts
  (`UIListLayout` and friends), `ClipsDescendants`, fonts or `ImageColor3`
  tinting yet. GUIs are not drawn in VR or in Studio's test client, and every
  player's `PlayerGui` replicates to every client rather than only its owner.
- **Tools and backpacks.** `StarterPack` exists as a container; nothing
  equips from it yet.
- **Animations.** Rigs have `Motor6D` joints and the client interpolates part
  poses, but there is no animation format or `Animator`.
- **Sound.** `SoundService` exists as a container only.
- **DataStores.** Places have no persistence API yet; only the world itself
  and player accounts are saved.
- **Type checking.** Luau's type annotations are parsed and erased, which is
  what the real Luau runtime does, but nothing checks them.

Everything else the API documents above works and is covered by tests.
