# Architecture

Notes on why things are the way they are, for anyone changing them.

## Processes

The **portal** serves the website, handles sign-in, lists worlds, and forks a
**game server** process per running place. It is the only process holding the
Migood client secret.

Players never hand a game server a credential. The portal verifies them and
issues a short-lived HMAC-signed **ticket** naming one place and carrying
their avatar; the game server verifies the signature with a secret the two
share. A game server therefore needs no database connection and no Migood
credentials, and a ticket for one place cannot be redeemed at another.

Worlds start on demand and are reaped once empty. Per-process isolation means
a script that hangs, leaks or crashes takes down its own game and nothing
else — which matters when the scripts are written by players.

## The instance tree

`Instance` is the base of everything, with a class registry carrying a
property **schema** per class: kind, default, and whether it replicates. The
schema is the single source of truth. Replication reads it to encode deltas,
the place format reads it to serialise, and Studio's properties panel reads it
to build its fields — so a property added to a class shows up in all three
without further work.

`setProperty` is the one write path that feeds the replication journal.
Engine code that mutates replicated state goes through it; a direct field
write is a local change that nobody hears about.

### Classes a DataModel creates for itself

`Terrain`, `Camera`, `StarterPlayerScripts` and `StarterCharacterScripts` are
created by every DataModel. Loading or replicating a tree must *adopt* those
rather than add a second copy — a duplicate `StarterPlayerScripts` means
`FindFirstChild` returns the empty one and a place's LocalScripts never run.
`AUTO_CREATED_CLASSES` is that list, and both paths are tested.

## Terrain

Voxels carry a material **and an occupancy** — how full the voxel is. The
surface is extracted through partly filled voxels with Surface Nets, so hills
are rounded rather than stepped and a terrain brush feathers its edge.

Collision uses the same field: a voxel is an obstacle only once it is more
than half full, and its box is shortened to the part actually filled, so a
body rests on the surface you can see.

Chunks are 16³, serialised as two run-length-encoded planes. A payload
carrying only materials still loads, treated as fully solid.

## Meshing, and the WebAssembly boundary

`assembly/mesher.ts` is compiled **twice**: by `asc` to WebAssembly and by
`tsc` to JavaScript. A hand-written fallback would be a second implementation
that drifts, and a mesher that disagrees with itself puts holes in the world
on whichever platform got the other version. A test meshes identical chunks
through both backends and asserts the vertex buffers match exactly.

The cost is that the source must stay inside the intersection of both
languages: explicit `i32`/`f64` annotations, typed arrays only, no closures,
no integer division, nothing allocated inside a loop (the WebAssembly build
uses the stub runtime, which never frees). The constraints are listed at the
top of the file, and there are tests for the two that bit: a memory-growth
test, and the parity test that caught f32-versus-f64 divergence.

Physics and terrain generation stay in plain TypeScript deliberately. Both
affect gameplay and must agree between server and client; two implementations
of either is a desync waiting to happen. Meshing is purely a rendering
concern, so a client that meshes differently looks slightly different rather
than disagreeing about where the ground is.

## The Luau VM

A tree-walking interpreter where **every evaluation step is a generator**.
That is what makes `coroutine.yield` and `task.wait` work: a suspended script
is a paused generator the scheduler resumes on a later frame, with no threads
and no callback rewriting.

The scheduler parks waiting threads, resumes them when due, and enforces an
instruction budget **per resume** rather than per lifetime — so a loop that
waits each pass runs forever, and one that never yields is killed.

## Replication

The server journals structural and property changes, drains them each tick,
and sends a delta. The client applies them to its own DataModel through
`ReplicaTree`, so the rest of the client reads the same instance tree the
server has rather than a parallel set of view models.

Ordering matters in two places, and both are handled: adds are sorted so
parents arrive before children, and instance references are resolved only
after every add in a packet has landed, since a ref can point at something
later in the same delta.

## Network ownership

Unless a place is `serverAuthoritative`, each player owns their own character
and simulates it locally, which takes a round trip out of every input. Server
and client run the same solver with disjoint `simulationFilter`s, so no body
is integrated twice, and bodies owned elsewhere still collide.

The server checks `NetworkOwnerId` rather than anything in the message, so a
client cannot claim a part by asking, and rejects implausible position jumps.
That is a sanity bound, not an anti-cheat: a place that needs to be sure keeps
authority server-side.

## Avatars

A `HumanoidDescription` is a few dozen numbers referring to catalogue ids. It
stores on an account in a few hundred bytes and travels inside the signed join
ticket, so a game server dresses a player correctly with no lookup of its own.

Applying one produces ordinary replicated state: part colours, `TextureId`
strings and child `Accessory` instances. No client needs avatar-specific code,
and a rig only has to provide a `Humanoid` and a `HumanoidRootPart` for the
engine to drive it.

Ids are range-checked per slot, so a hat id in the `Pants` field is rejected
rather than quietly producing a character with no trousers.
