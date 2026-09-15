import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  CHUNK,
  FLOATS_PER_VERTEX,
  PAD,
  PADDED_VOLUME,
  VERTEX_LAYOUT,
  createJsMesher,
  createMesher,
  createWasmMesher,
  newPaddedVolume,
  packPadded,
} from "../dist/src/index.js";

const wasmBytes = await readFile(new URL("../build/miblox.wasm", import.meta.url));
const wasm = await createWasmMesher(wasmBytes);
const js = createJsMesher();

const AIR = 0;
const GRASS = 1;
const ROCK = 2;
const WATER = 5;

/** Builds a padded volume from a predicate over chunk-local coordinates. */
function volume(sample) {
  return packPadded(newPaddedVolume(), sample);
}

/** A deterministic pseudo-random volume, so both backends see the same input. */
function noiseVolume(seed) {
  let state = seed | 0 || 1;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
  const out = newPaddedVolume();
  for (let i = 0; i < PADDED_VOLUME; i++) {
    const r = next();
    out[i] = r < 0.45 ? AIR : r < 0.7 ? GRASS : r < 0.9 ? ROCK : WATER;
  }
  return out;
}

test("the wasm module actually loaded", () => {
  assert.equal(wasm.backend, "wasm");
  assert.equal(js.backend, "js");
});

test("an empty chunk produces no geometry", () => {
  const empty = volume(() => AIR);
  for (const mesher of [wasm, js]) {
    const mesh = mesher.meshChunk(empty);
    assert.equal(mesh.quadCount, 0, mesher.backend);
    assert.equal(mesh.vertexCount, 0, mesher.backend);
    assert.equal(mesh.indexCount, 0, mesher.backend);
  }
});

test("a chunk fully enclosed by neighbours produces no geometry", () => {
  // Solid everywhere, including the border, so no face is exposed.
  const solid = volume(() => ROCK);
  for (const mesher of [wasm, js]) {
    assert.equal(mesher.meshChunk(solid).quadCount, 0, mesher.backend);
  }
});

test("a single voxel produces exactly six merged quads", () => {
  const one = volume((x, y, z) => (x === 5 && y === 5 && z === 5 ? ROCK : AIR));
  for (const mesher of [wasm, js]) {
    const mesh = mesher.meshChunk(one);
    assert.equal(mesh.quadCount, 6, mesher.backend);
    assert.equal(mesh.vertexCount, 24, mesher.backend);
    assert.equal(mesh.indexCount, 36, mesher.backend);
  }
});

test("greedy merging collapses a flat slab", () => {
  // One full layer of the chunk with air above and below. The top and bottom
  // are each one 16x16 quad; the four sides are each 16x1.
  const slab = volume((x, y, z) =>
    y === 8 && x >= 0 && x < CHUNK && z >= 0 && z < CHUNK ? GRASS : AIR,
  );
  for (const mesher of [wasm, js]) {
    const mesh = mesher.meshChunk(slab);
    assert.equal(mesh.quadCount, 6, `${mesher.backend}: expected 6 merged quads`);
    // Unmerged this would be 16*16*2 + 16*4 = 576 quads.
    assert.ok(mesh.quadCount < 576);
  }
});

test("different materials do not merge together", () => {
  // Half the slab grass, half rock: the top and bottom split in two.
  const split = volume((x, y, z) => {
    if (y !== 8 || x < 0 || x >= CHUNK || z < 0 || z >= CHUNK) return AIR;
    return x < 8 ? GRASS : ROCK;
  });
  for (const mesher of [wasm, js]) {
    const mesh = mesher.meshChunk(split);
    assert.ok(
      mesh.quadCount > 6,
      `${mesher.backend}: a material boundary must break the merge`,
    );
  }
});

test("water is meshed in its own pass, not merged with solids", () => {
  const mixed = volume((x, y, z) => {
    if (x < 0 || x >= CHUNK || z < 0 || z >= CHUNK) return AIR;
    if (y === 4) return ROCK;
    if (y === 5) return WATER;
    return AIR;
  });
  for (const mesher of [wasm, js]) {
    const solid = mesher.meshChunk(mixed, 1);
    const water = mesher.meshChunk(mixed, 0);
    assert.ok(solid.quadCount > 0, `${mesher.backend}: expected solid geometry`);
    assert.ok(water.quadCount > 0, `${mesher.backend}: expected water geometry`);
    // Every material id in the solid pass must be non-water.
    for (let i = 0; i < solid.vertexCount; i++) {
      const m = solid.vertices[i * FLOATS_PER_VERTEX + VERTEX_LAYOUT.material.offset];
      assert.notEqual(m, WATER, `${mesher.backend}: water leaked into the solid pass`);
    }
    for (let i = 0; i < water.vertexCount; i++) {
      const m = water.vertices[i * FLOATS_PER_VERTEX + VERTEX_LAYOUT.material.offset];
      assert.equal(m, WATER, `${mesher.backend}: non-water in the water pass`);
    }
  }
});

test("vertices stay inside the chunk bounds", () => {
  const mesh = wasm.meshChunk(noiseVolume(99));
  for (let i = 0; i < mesh.vertexCount; i++) {
    const o = i * FLOATS_PER_VERTEX;
    for (let axis = 0; axis < 3; axis++) {
      const value = mesh.vertices[o + axis];
      assert.ok(value >= 0 && value <= CHUNK, `axis ${axis} out of range: ${value}`);
    }
  }
});

test("normals are unit axis vectors", () => {
  const mesh = wasm.meshChunk(noiseVolume(5));
  assert.ok(mesh.vertexCount > 0);
  for (let i = 0; i < mesh.vertexCount; i++) {
    const o = i * FLOATS_PER_VERTEX + VERTEX_LAYOUT.normal.offset;
    const [nx, ny, nz] = [mesh.vertices[o], mesh.vertices[o + 1], mesh.vertices[o + 2]];
    assert.equal(Math.abs(nx) + Math.abs(ny) + Math.abs(nz), 1, "exactly one axis set");
  }
});

test("every index refers to a real vertex", () => {
  const mesh = wasm.meshChunk(noiseVolume(17));
  assert.ok(mesh.indexCount > 0);
  for (let i = 0; i < mesh.indexCount; i++) {
    assert.ok(
      mesh.indices[i] < mesh.vertexCount,
      `index ${mesh.indices[i]} >= vertexCount ${mesh.vertexCount}`,
    );
  }
  assert.equal(mesh.indexCount % 3, 0, "indices must form whole triangles");
});

test("occlusion is darker in a concave corner than on open ground", () => {
  // An L-shaped notch: the voxel in the corner should have darkened vertices.
  const notch = volume((x, y, z) => {
    if (y < 0 || y > 8) return AIR;
    if (x < 0 || x >= CHUNK || z < 0 || z >= CHUNK) return AIR;
    // A floor with a wall running along x = 8.
    if (y === 0) return ROCK;
    return x === 8 ? ROCK : AIR;
  });
  const mesh = wasm.meshChunk(notch);
  let darkest = 1;
  let lightest = 0;
  for (let i = 0; i < mesh.vertexCount; i++) {
    const ao = mesh.vertices[i * FLOATS_PER_VERTEX + VERTEX_LAYOUT.occlusion.offset];
    darkest = Math.min(darkest, ao);
    lightest = Math.max(lightest, ao);
  }
  assert.ok(lightest > darkest, "expected a range of occlusion values");
  assert.ok(darkest < 1, "expected some vertices to be occluded");
  assert.ok(lightest <= 1 && darkest >= 0, "occlusion must stay in 0..1");
});

test("the wasm and javascript backends produce identical geometry", () => {
  // The whole point of compiling one source twice: the fallback must not be a
  // second implementation that can drift from the first.
  for (const seed of [1, 2, 3, 42, 1337, 99999]) {
    const vol = noiseVolume(seed);
    for (const pass of [1, 0]) {
      const a = wasm.meshChunk(vol, pass);
      const b = js.meshChunk(vol, pass);
      assert.equal(a.quadCount, b.quadCount, `seed ${seed} pass ${pass}: quad count`);
      assert.equal(a.vertexCount, b.vertexCount, `seed ${seed} pass ${pass}: vertex count`);
      assert.deepEqual(
        Array.from(a.vertices),
        Array.from(b.vertices),
        `seed ${seed} pass ${pass}: vertex data`,
      );
      assert.deepEqual(
        Array.from(a.indices),
        Array.from(b.indices),
        `seed ${seed} pass ${pass}: indices`,
      );
    }
  }
});

test("both backends agree on hand-built shapes too", () => {
  const shapes = [
    volume((x, y, z) => (y < 4 ? GRASS : AIR)),
    volume((x, y, z) => ((x + y + z) % 2 === 0 ? ROCK : AIR)),
    volume((x, y, z) => (x === y ? ROCK : z === 3 ? WATER : AIR)),
    volume((x, y, z) => (y < 2 ? ROCK : y < 5 ? WATER : AIR)),
  ];
  for (const [i, vol] of shapes.entries()) {
    for (const pass of [1, 0]) {
      const a = wasm.meshChunk(vol, pass);
      const b = js.meshChunk(vol, pass);
      assert.deepEqual(Array.from(a.vertices), Array.from(b.vertices), `shape ${i} pass ${pass}`);
    }
  }
});

test("a checkerboard is the worst case and still fits the buffers", () => {
  // Every voxel isolated, so no merging is possible at all.
  const checker = volume((x, y, z) => ((x + y + z) % 2 === 0 ? ROCK : AIR));
  for (const mesher of [wasm, js]) {
    const mesh = mesher.meshChunk(checker);
    assert.ok(mesh.quadCount > 1000, `${mesher.backend}: expected many quads`);
    assert.equal(mesh.vertexCount, mesh.quadCount * 4);
    assert.equal(mesh.indexCount, mesh.quadCount * 6);
  }
});

test("createMesher falls back to javascript on a bad module", () => {
  let reason;
  return createMesher(new Uint8Array([0, 1, 2, 3]), (err) => {
    reason = err;
  }).then((mesher) => {
    assert.equal(mesher.backend, "js");
    assert.ok(reason, "the fallback reason should be reported");
  });
});

test("createMesher returns the javascript backend when given no module", async () => {
  const mesher = await createMesher();
  assert.equal(mesher.backend, "js");
});

test("a wrongly sized volume is rejected", () => {
  assert.throws(() => wasm.meshChunk(new Uint8Array(10)), /padded volume/);
  assert.throws(() => js.meshChunk(new Uint8Array(10)), /padded volume/);
});

test("meshing is repeatable and does not accumulate state", () => {
  const vol = noiseVolume(7);
  const first = wasm.meshChunk(vol);
  const second = wasm.meshChunk(vol);
  assert.equal(first.vertexCount, second.vertexCount);
  assert.deepEqual(Array.from(first.vertices), Array.from(second.vertices));
});

test("layout constants agree between the module and the host", () => {
  assert.equal(PAD, CHUNK + 2);
  assert.equal(PADDED_VOLUME, PAD ** 3);
  assert.equal(FLOATS_PER_VERTEX, 10);
});

// ---------------------------------------------------------------------------
// Smooth terrain
// ---------------------------------------------------------------------------

/** A density volume from a signed-distance style function. */
function densityVolume(fill) {
  const materials = newPaddedVolume();
  const occupancy = newPaddedVolume();
  for (let y = -1; y <= CHUNK; y++) {
    for (let z = -1; z <= CHUNK; z++) {
      for (let x = -1; x <= CHUNK; x++) {
        const i = (y + 1) * PAD * PAD + (z + 1) * PAD + (x + 1);
        const value = Math.max(0, Math.min(1, fill(x, y, z)));
        occupancy[i] = Math.round(value * 255);
        materials[i] = value > 0 ? ROCK : AIR;
      }
    }
  }
  return { materials, occupancy };
}

test("an empty density field produces no smooth geometry", () => {
  const { materials, occupancy } = densityVolume(() => 0);
  for (const mesher of [wasm, js]) {
    const mesh = mesher.meshChunkSmooth(materials, occupancy);
    assert.equal(mesh.vertexCount, 0, mesher.backend);
    assert.equal(mesh.indexCount, 0, mesher.backend);
  }
});

test("a fully solid field produces no smooth geometry", () => {
  const { materials, occupancy } = densityVolume(() => 1);
  for (const mesher of [wasm, js]) {
    assert.equal(mesher.meshChunkSmooth(materials, occupancy).indexCount, 0, mesher.backend);
  }
});

test("a flat half-filled layer produces a surface", () => {
  // Ground up to y = 8, with the boundary voxel half full.
  const { materials, occupancy } = densityVolume((x, y) => (y < 8 ? 1 : y === 8 ? 0.5 : 0));
  const mesh = wasm.meshChunkSmooth(materials, occupancy);
  assert.ok(mesh.vertexCount > 0, "expected a surface");
  assert.equal(mesh.indexCount % 3, 0);
  for (let i = 0; i < mesh.indexCount; i++) {
    assert.ok(mesh.indices[i] < mesh.vertexCount, "index out of range");
  }
});

test("smooth normals vary across a slope, unlike blocky ones", () => {
  // A ramp: density falls off with height and along x, so the surface tilts.
  const { materials, occupancy } = densityVolume((x, y) => (8 + x * 0.35 - y) / 2);
  const mesh = wasm.meshChunkSmooth(materials, occupancy);
  assert.ok(mesh.vertexCount > 0);

  const seen = new Set();
  let offAxis = 0;
  for (let i = 0; i < mesh.vertexCount; i++) {
    const o = i * FLOATS_PER_VERTEX + VERTEX_LAYOUT.normal.offset;
    const n = [mesh.vertices[o], mesh.vertices[o + 1], mesh.vertices[o + 2]];
    seen.add(n.map((v) => v.toFixed(2)).join(","));
    // A blocky mesh only ever emits axis-aligned normals; a slope must not.
    const axisAligned = Math.abs(Math.abs(n[0]) + Math.abs(n[1]) + Math.abs(n[2]) - 1) < 1e-3
      && n.filter((v) => Math.abs(v) > 0.001).length === 1;
    if (!axisAligned) offAxis++;
  }
  assert.ok(offAxis > 0, "a sloped surface should produce non-axis-aligned normals");
  assert.ok(seen.size > 3, `expected varied normals, got ${seen.size}`);
});

test("smooth normals are unit length", () => {
  const { materials, occupancy } = densityVolume((x, y, z) => (10 + Math.sin(x / 3) * 2 - y) / 2);
  const mesh = wasm.meshChunkSmooth(materials, occupancy);
  assert.ok(mesh.vertexCount > 0);
  for (let i = 0; i < mesh.vertexCount; i++) {
    const o = i * FLOATS_PER_VERTEX + VERTEX_LAYOUT.normal.offset;
    const len = Math.hypot(mesh.vertices[o], mesh.vertices[o + 1], mesh.vertices[o + 2]);
    assert.ok(Math.abs(len - 1) < 1e-3, `normal length ${len}`);
  }
});

test("the smooth surface sits where the density crosses the threshold", () => {
  // Half-full at y = 8 means the surface belongs inside that voxel, not on its
  // boundary, which is the whole point of carrying occupancy.
  const { materials, occupancy } = densityVolume((x, y) => (y < 8 ? 1 : y === 8 ? 0.5 : 0));
  const mesh = wasm.meshChunkSmooth(materials, occupancy);
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < mesh.vertexCount; i++) {
    const y = mesh.vertices[i * FLOATS_PER_VERTEX + 1];
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  assert.ok(minY > 8 && maxY < 9.5, `surface should sit near y=8.5, got ${minY}..${maxY}`);
});

test("smooth output is bounded by one vertex per cell", () => {
  // Surface Nets emits at most one vertex per cell, which is what keeps a
  // smooth chunk cheap. (It is not always fewer triangles than the blocky
  // mesher: that one merges coplanar faces, so it wins on flat ground and
  // loses on slopes, where it would need a step per voxel.)
  const { materials, occupancy } = densityVolume(
    (x, y, z) => (9 + Math.sin(x / 4) * 3 + Math.cos(z / 4) * 3 - y) / 2,
  );
  const smooth = wasm.meshChunkSmooth(materials, occupancy);
  assert.ok(smooth.vertexCount > 0);
  const cells = (CHUNK + 1) ** 3;
  assert.ok(smooth.vertexCount <= cells, `${smooth.vertexCount} vertices for ${cells} cells`);
});

test("the wasm and javascript backends agree on smooth geometry too", () => {
  const shapes = [
    (x, y) => (8 - y) / 2,
    (x, y, z) => (10 + Math.sin(x / 3) * 2 + Math.cos(z / 3) * 2 - y) / 2,
    (x, y, z) => 1 - Math.hypot(x - 8, y - 8, z - 8) / 6,
    (x, y, z) => ((x + y + z) % 5) / 4,
  ];
  for (const [i, fill] of shapes.entries()) {
    const { materials, occupancy } = densityVolume(fill);
    const a = wasm.meshChunkSmooth(materials, occupancy);
    const b = js.meshChunkSmooth(materials, occupancy);
    assert.equal(a.vertexCount, b.vertexCount, `shape ${i}: vertex count`);
    assert.deepEqual(Array.from(a.vertices), Array.from(b.vertices), `shape ${i}: vertices`);
    assert.deepEqual(Array.from(a.indices), Array.from(b.indices), `shape ${i}: indices`);
  }
});

test("meshing smoothly many times does not grow memory without bound", () => {
  // The wasm build uses the stub runtime, which never frees, so anything
  // allocated per call would accumulate. Meshing repeatedly must not grow it.
  const { materials, occupancy } = densityVolume((x, y, z) => (9 + Math.sin(x / 4) * 3 - y) / 2);
  const before = wasm.memoryPages;
  for (let i = 0; i < 200; i++) wasm.meshChunkSmooth(materials, occupancy);
  assert.equal(wasm.memoryPages, before, "linear memory grew across repeated meshing");
});

test("a sphere of density produces a closed, watertight surface", () => {
  const { materials, occupancy } = densityVolume(
    (x, y, z) => 1 - Math.hypot(x - 7.5, y - 7.5, z - 7.5) / 5,
  );
  const mesh = wasm.meshChunkSmooth(materials, occupancy);
  assert.ok(mesh.vertexCount > 20, "expected a sphere's worth of vertices");

  // Every edge in a closed mesh is shared by exactly two triangles.
  const edges = new Map();
  for (let i = 0; i < mesh.indexCount; i += 3) {
    const tri = [mesh.indices[i], mesh.indices[i + 1], mesh.indices[i + 2]];
    for (let e = 0; e < 3; e++) {
      const a = tri[e];
      const b = tri[(e + 1) % 3];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  const unshared = [...edges.values()].filter((count) => count !== 2).length;
  assert.equal(unshared, 0, `${unshared} edges are not shared by exactly two triangles`);
});
