import type { PluginRecord } from "./plugins.js";

/**
 * Plugins that ship with Studio.
 *
 * They are ordinary Luau plugins with no privileged access, which keeps the
 * plugin API honest: if the character adder can be written against it, so can
 * anything a user wants to write.
 */

const CHARACTER_ADDER = `--!strict
-- Character Adder
--
-- Spawns a character into the world from a MiBlox player's saved look, or
-- from a template. Everything it does goes through the ordinary plugin API.

local function spawnFrom(who: string)
	local ok, result = pcall(function()
		return plugin:HttpGetJson("/api/avatars/" .. who)
	end)

	if not ok or not result or not result.avatar then
		plugin:Notify("Could not find a player called " .. who)
		return
	end

	local model = Avatar.Build(result.avatar)
	model.Name = result.username or who
	model.Parent = workspace
	plugin:SetSelection(model)
	plugin:MarkEdited()
	plugin:Notify("Added " .. model.Name .. " to the world")
end

plugin:CreateButton("Add Player", "Spawn a MiBlox player's avatar", function()
	local who = plugin:Prompt("Whose avatar? Enter a MiBlox username.", "")
	if not who or who == "" then return end
	spawnFrom(who)
end)

plugin:CreateButton("Add Template", "Spawn a template player", function()
	spawnFrom("Template")
end)

plugin:CreateButton("Copy Look", "Copy the selected character's look onto another", function()
	local source = plugin:GetSelection()
	if not source or not source:FindFirstChildOfClass("Humanoid") then
		plugin:Notify("Select a character first")
		return
	end

	local description = Avatar.Describe(source)
	local target = plugin:Prompt("Paste this look onto which model? Enter its name.", "")
	if not target or target == "" then return end

	local model = workspace:FindFirstChild(target)
	if not model or not model:FindFirstChildOfClass("Humanoid") then
		plugin:Notify(target .. " is not a character in the Workspace")
		return
	end

	Avatar.Apply(model, description)
	plugin:MarkEdited()
	plugin:Notify("Copied " .. source.Name .. "'s look onto " .. target)
end)
`;

const PART_TOOLS = `--!strict
-- Part Tools
--
-- Small things that are tedious by hand: scattering, aligning and colouring.

plugin:CreateButton("Scatter", "Scatter copies of the selection nearby", function()
	local source = plugin:GetSelection()
	if not source or not source:IsA("BasePart") then
		plugin:Notify("Select a part first")
		return
	end

	local count = tonumber(plugin:Prompt("How many copies?", "12")) or 12
	local spread = tonumber(plugin:Prompt("How far apart, in studs?", "60")) or 60

	local folder = Instance.new("Folder")
	folder.Name = source.Name .. " Scatter"
	folder.Parent = workspace

	for i = 1, math.clamp(count, 1, 200) do
		local copy = source:Clone()
		copy.CFrame = source.CFrame + Vector3.new(
			(math.random() - 0.5) * spread * 2,
			0,
			(math.random() - 0.5) * spread * 2
		)
		copy.Parent = folder
	end

	plugin:SetSelection(folder)
	plugin:MarkEdited()
	plugin:Notify("Scattered " .. count .. " copies")
end)

plugin:CreateButton("Rainbow", "Colour the selection's descendants", function()
	local root = plugin:GetSelection()
	if not root then
		plugin:Notify("Select something first")
		return
	end

	local parts = {}
	if root:IsA("BasePart") then
		table.insert(parts, root)
	end
	for _, descendant in root:GetDescendants() do
		if descendant:IsA("BasePart") then
			table.insert(parts, descendant)
		end
	end

	for index, part in parts do
		local hue = (index - 1) / math.max(#parts, 1)
		-- A simple hue sweep through the primaries.
		local r = math.abs(((hue * 6 + 0) % 6) - 3) - 1
		local g = math.abs(((hue * 6 + 4) % 6) - 3) - 1
		local b = math.abs(((hue * 6 + 2) % 6) - 3) - 1
		part.Color = Color3.new(
			math.clamp(r, 0, 1),
			math.clamp(g, 0, 1),
			math.clamp(b, 0, 1)
		)
	end

	plugin:MarkEdited()
	plugin:Notify("Coloured " .. #parts .. " parts")
end)
`;

export const BUILTIN_PLUGINS: PluginRecord[] = [
  { name: "Character Adder", source: CHARACTER_ADDER, builtin: true, enabled: true },
  { name: "Part Tools", source: PART_TOOLS, builtin: true, enabled: true },
];
