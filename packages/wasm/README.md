# @miblox/wasm

The greedy voxel mesher, compiled to WebAssembly.

## Why this is the part that gets compiled

Terrain meshing is the one genuinely compute-bound thing the client does every
frame it streams a chunk. Emitting six quads per voxel gives ~150k triangles
for a single solid 16³ chunk; merging coplanar faces of the same material
brings a typical chunk to a few hundred. That is the difference between a
playable frame rate on a phone and not.

```
flat 16x16 slab:      576 quads unmerged  ->    6 merged
half-full chunk:     ~400 quads unmerged  ->    1 merged (just the top face)
checkerboard:      13056 quads (worst case, nothing can merge)
```

## One source, two backends

`assembly/mesher.ts` is compiled **twice**:

| Build | Tool | Output | Used when |
| --- | --- | --- | --- |
| WebAssembly | `asc` | `build/miblox.wasm` | normally |
| JavaScript | `tsc` | `dist/assembly/mesher.js` | WASM is blocked or fails to load |

This is deliberate. A hand-written JS fallback would be a second
implementation that drifts from the first, and a mesher that disagrees with
itself produces holes in the world on whichever platform got the other
version. Compiling one source both ways makes drift impossible, and there is a
test that meshes the same chunks through both and asserts the vertex buffers
match exactly.

The cost is that the source has to stay inside the intersection of both
languages: explicit `i32`/`f32` annotations, typed arrays only, no closures or
integer division. The constraints are listed at the top of the file.

## Interface

WASM can only pass numbers, so the host asks for buffer addresses once and then
reads and writes linear memory:

```ts
const mesher = await createMesher(wasmBytes, (err) => console.warn("fallback:", err));
const padded = newPaddedVolume();          // (16+2)^3 bytes
packPadded(padded, (x, y, z) => world.getVoxel(cx * 16 + x, cy * 16 + y, cz * 16 + z));

const solid = mesher.meshChunk(padded, 1); // opaque pass
const water = mesher.meshChunk(padded, 0); // translucent pass
```

The volume is padded with one voxel of the neighbouring chunks' data so that a
face on a chunk boundary is emitted only where it is genuinely exposed —
otherwise every chunk seam shows a wall of hidden faces.

### Vertex layout

10 floats per vertex, interleaved:

| Offset | Size | Attribute |
| --- | --- | --- |
| 0 | 3 | position, chunk-local (0..16) |
| 3 | 3 | normal, always a unit axis vector |
| 6 | 2 | uv, in voxels, so textures tile across a merged quad |
| 8 | 1 | material id |
| 9 | 1 | ambient occlusion, 0.25..1.0, as a light multiplier |

`VERTEX_LAYOUT` exports these offsets so nothing hard-codes them twice.

## Ambient occlusion

Each face corner samples the three voxels touching it and darkens accordingly,
which is what makes concave corners readable on untextured blocks. Two cells
merge only when their material *and* all four corner occlusion values match —
otherwise merging would flatten the shading it just computed.

## A note on what is *not* in WASM

Physics and terrain generation stay in `@miblox/core` as plain TypeScript, and
deliberately so: both affect gameplay, both must agree bit-for-bit between the
server and every client, and two implementations of either is a desync waiting
to happen. Meshing is purely a rendering concern — a client that meshes
differently looks slightly different, it does not disagree with the server
about where the ground is.
