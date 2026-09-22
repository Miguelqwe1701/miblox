# MiBlox

A blocky sandbox game platform: build worlds, script them in Luau, and play
them in a browser, on the desktop, on a phone, or in VR.

Everything below runs. There is no engine binary to install and no asset
pipeline to set up — clone it, build it, and you have a portal serving a
website, a lobby you walk into, and game servers it launches on demand.

```bash
npm install
npm run build
npm run place:build     # generates places/lobby.json and places/baseplate.json
npm start               # portal on http://localhost:3000
```

Then open <http://localhost:3000> and press **Enter the Lobby**.

## What it is

| | |
| --- | --- |
| **Play** | `/` — the menu, or walk into the lobby and pick a world from a panel |
| **Build** | `/studio/<world>` — an editor with an explorer, properties, terrain brushes, a script editor and a test server |
| **Customise** | `/avatar` — a HumanoidDescription editor with a live 3D preview |
| **Script** | Luau, running the same interpreter on the server and on every client |

## How it is put together

```
                         ┌──────────────────────────────┐
  browser ───────────────│  portal  (one process)        │
  desktop (Electron)     │  website, sign-in, catalogue  │
  phone                  │  holds the Migood secret      │
  VR headset             └───────────────┬──────────────┘
                                         │ forks a process per world
                         ┌───────────────▼──────────────┐
                         │  game server (one per place)  │
                         │  DataModel, physics, Luau     │
                         │  WebSocket replication        │
                         └──────────────────────────────┘
```

The portal is the only process that holds the Migood client secret. It
verifies a player once and hands them a short-lived signed **ticket** naming
one place and carrying their avatar; the game server checks the signature
against a shared secret and never talks to Migood or a database at all.

A world starts when the first player asks to join it and is shut down once it
has been empty for a while, so an idle catalogue costs nothing. Each world is
its own process, so a script that hangs or crashes takes down that game and
nothing else.

### Packages

| Package | What it does |
| --- | --- |
| `@miblox/core` | The engine: instance tree, voxel terrain, physics, replication, avatars. No dependencies. |
| `@miblox/luau` | A Luau interpreter in TypeScript, so the same VM runs everywhere. |
| `@miblox/scripting` | Binds the engine into Luau: `game`, `Instance.new`, `Vector3`, events, `require`. |
| `@miblox/wasm` | The greedy and smooth terrain meshers, compiled to WebAssembly. |
| `@miblox/auth` | Migood OAuth, linked MiBlox accounts, sessions. |
| `@miblox/server` | The portal and the per-place game servers. |
| `@miblox/client` | Renderer, input, VR, Studio and the avatar editor. |
| `@miblox/desktop` | An Electron window around the web client. |

## Decisions worth knowing about

**One language, one engine.** The physics that decides where you land, the
Luau VM that runs a place's scripts, and the code that draws it are the same
TypeScript on the server, in the browser, on a phone and in a headset.
Desktop is a packaging decision, not a second implementation to keep in step.

**WebAssembly where it earns its place.** Terrain meshing is the one genuinely
compute-bound job, so that is what gets compiled. The mesher source is built
twice — by `asc` to WebAssembly and by `tsc` to JavaScript — so a browser that
cannot load the `.wasm` runs the same algorithm rather than a second
implementation that could drift and put holes in the world. A test meshes
identical chunks through both and asserts the vertex buffers match exactly.

Physics and terrain generation stay in plain TypeScript on purpose: both
affect gameplay and must agree between server and client, where two
implementations would be a desync waiting to happen.

**Smooth terrain.** Voxels carry how *full* they are, not just what they are
made of, and the surface is contoured through partly filled voxels with
Surface Nets. Collision uses the same field, so you stand on the surface you
can see rather than a blocky approximation of it.

**Network ownership.** Unless a place sets `serverAuthoritative`, each player
owns their own character and simulates it locally, which takes a round trip
out of every input. The server checks `NetworkOwnerId` rather than anything in
the message, so a client cannot claim a part by asking, and rejects
implausible jumps. A place that cares keeps everything server-side instead.

**Avatars are data.** A character's whole appearance is a
`HumanoidDescription`: a few dozen numbers referring to catalogue ids. It
stores on an account in a few hundred bytes, travels inside the signed join
ticket, and builds into ordinary replicated instances — part colours,
`TextureId` strings, child `Accessory` models — so no client needs
avatar-specific code to display one.

## Scripting

Luau, with the API a Roblox script expects:

```lua
local Players = game:GetService("Players")

local platform = Instance.new("Part")
platform.Size = Vector3.new(20, 2, 20)
platform.CFrame = CFrame.new(0, 30, 0)
platform.Anchored = true
platform.Material = Enum.Material.Wood
platform.Parent = workspace

Players.PlayerAdded:Connect(function(player)
	player.CharacterAdded:Connect(function(character)
		character:WaitForChild("Humanoid").WalkSpeed = 24
	end)
end)

task.spawn(function()
	while true do
		platform.CFrame = platform.CFrame * CFrame.Angles(0, 0.02, 0)
		task.wait()
	end
end)
```

`Script` runs on the server, `LocalScript` on each client, `ModuleScript` is
shared through `require`. Every event handler runs on its own thread, so a
handler that yields cannot block the engine that fired it, and a script that
loops without yielding is stopped rather than hanging the world.

See [docs/scripting.md](docs/scripting.md) for the full surface.

## Studio

`/studio/<world>` edits a place with the same engine that runs it.

- an explorer over the instance tree, and a properties panel generated from
  each class's schema, so a property added to the engine appears without
  further work
- terrain brushes over the same density field the game renders
- a script editor, and **Run** / **Play** to start a test server inside Studio
  with a Server/Client switcher and a tagged output panel
- plugins written in Luau against a `plugin` global. Two ship built in —
  Character Adder, which spawns any player's saved avatar, and Part Tools.
  They use only the public API, which is the test of whether that API is good
  enough for anyone else to write one.

## Sign-in

Optional. With no Migood credentials configured, everybody plays as a guest,
which is what local development wants.

```bash
export MIBLOX_MIGOOD_CLIENT_ID=...
export MIBLOX_MIGOOD_CLIENT_SECRET=...     # server-side only, never shipped
export MIBLOX_SESSION_SECRET=...           # must be stable across restarts
npm start
```

All four Migood flows are supported: the in-frame SDK token, the browser
redirect, device codes for headsets and consoles, and built-in verification
webhooks. A MiBlox account is our own record with its own changeable username;
the Migood identity is what it is *linked* to. See
[packages/auth/README.md](packages/auth/README.md).

## Tests

```bash
npm test
npm run typecheck -w @miblox/client   # the other packages are type-checked by their build
```

Around 260 tests across the packages, covering the instance tree, terrain and
its density field, physics and network ownership, the Luau grammar and
scheduler, pattern matching, mesher backend parity, avatars, replication,
every auth flow against a stubbed API, and an end-to-end suite that boots a
portal, forks a real game-server process, connects over WebSocket and checks
that forged, expired and wrong-place tickets are all refused.

## Screenshots

In [`demo/`](demo/), captured by driving a real browser against a running
server with Playwright (`node demo.mjs`). The frame rates in those shots are
software rendering inside a container with no GPU.
