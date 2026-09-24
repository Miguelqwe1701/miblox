# Working in this repo

MiBlox is a blocky sandbox game platform — a portal that serves a website and
forks a game-server process per world, an engine shared by server and client,
and a Luau interpreter that runs in both. [README.md](README.md) explains what
it is and why it is built that way; this file is about working on it.

## Commands

```bash
npm install
npm run build        # wasm → core → luau → scripting → auth → server → client
npm run typecheck    # the client alone; every other package's build does it
npm test             # ~300 tests across six packages
npm start            # portal on http://localhost:3000
npm run place:build  # regenerates places/*.json (they are committed)
bash scripts/portal.sh restart   # rebuild-and-restart during development
```

**Build before you test.** `dist/` is gitignored and every package's tests
import built output, not the TypeScript sources, so `npm test` on a fresh
clone fails until `npm run build` has run. The SessionStart hook in
`.claude/hooks/` does this for web sessions.

**Build order is dependency order.** `@miblox/wasm` first: the other packages
resolve it through the `.d.ts` its build emits, and the client copies
`miblox.wasm` into `public/` in its prebuild step.

**The client's build type-checks it.** Vite strips types without checking
them, so `tsc` is wired into `packages/client`'s build script ahead of the
bundle - without that a type error there passes the build and only surfaces at
runtime. Leave it there. To check types on their own, without bundling:

```bash
npm run typecheck
```

The other packages are built by `tsc`, so their builds already type-check
them. There is no linter configured.

## Verify changes by running the thing

Tests pass on code that is visibly broken in a browser. Several real bugs here
were invisible to the suite and obvious on screen within seconds: a place's
LocalScripts never running at all, a MeshPart drawing as a box, characters
buried to the hips, a head rendering solid black.

Chromium is pre-installed. Never run `playwright install`:

```js
const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
});
```

`demo.mjs` (feature walkthrough) and `trailer.mjs` (cinematic camera) both
drive a real browser against a running portal and write to `demo/`. Copy either
as the starting point for a one-off diagnostic; when you are done with a
throwaway script, delete it rather than committing it.

Rendering is software, with no GPU, so frame rates in captures are low. That is
the container, not the engine.

## Engine invariants

Breaking one of these produces a bug that looks like something else entirely.

- **Only `HumanoidRootPart` collides.** Limbs would snag on geometry. The root
  is the torso's 2×2×1 box, so the collision box is extended down by
  `Humanoid.HipHeight` to reach the soles — otherwise a character rests its
  torso on the ground with its legs buried.
- **Limbs are posed, not dragged.** `animateCharacter` in
  `packages/core/src/animation.ts` places every limb against the root each
  physics step. Translating limbs alongside the root instead leaves them
  facing the wrong way when a character turns.
- **The two mesher backends must agree exactly.** `packages/wasm` is built
  twice, by `asc` to WebAssembly and by `tsc` to JavaScript, so a browser that
  cannot load the `.wasm` runs the same algorithm. A test meshes identical
  chunks through both and compares vertex buffers. Keep the smooth mesher's
  arithmetic in `f64` and narrow to `f32` only on store, or the backends
  diverge. Allocate scratch buffers at module level: the stub runtime never
  frees, so allocating inside a meshing loop leaks.
- **Physics and terrain generation stay in plain TypeScript.** Both must agree
  between server and client; a second implementation is a desync waiting to
  happen.
- **A renderer must re-check properties it read at creation.** `TextureId`,
  `MeshId` and the rest arrive *after* the part does, so choosing geometry or
  materials once when a part appears is wrong. `world-view.ts` compares a
  geometry key and a material key every frame.
- **Services in `AUTO_CREATED_CLASSES` are adopted, not added.** `Terrain`,
  `Camera`, `StarterPlayerScripts` and `StarterCharacterScripts` already exist
  in a fresh DataModel. Loading or replicating a place that also contains them
  must adopt the existing instance, or the duplicate silently shadows the real
  one and its scripts never run.

## Security

- The Migood client secret lives only in the portal process and must never
  reach a client. Game servers get an HMAC-signed join ticket naming one place
  and carrying the player's avatar — they talk to neither Migood nor a
  database.
- `MIBLOX_SESSION_SECRET` must stay stable across restarts or every session is
  invalidated.
- The server checks `NetworkOwnerId` rather than anything in the message, so a
  client cannot claim a part by asking.

## Conventions

- Comments explain *why*, not what. Most of the ones already here record a
  decision or a trap; match that rather than narrating the code.
- `data/portal.pid` and `data/portal.log` are runtime state and are gitignored.
  Don't commit them — a stale pidfile makes `portal.sh restart` silently serve
  the old build.
- Tests are `node --test` with `node:assert/strict`, named as a sentence
  describing the behaviour ("a character stands on its feet rather than sinking
  to the hips").
