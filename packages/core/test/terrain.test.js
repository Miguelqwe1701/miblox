import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Chunk,
  CHUNK_VOLUME,
  MATERIAL_ID,
  VOXEL_SIZE,
  VoxelWorld,
  Vector3,
  encodeChunkRLE,
  decodeChunkRLE,
  decodeChunkPlanes,
} from "../dist/index.js";

test("voxel set and get round-trip across chunk borders", () => {
  const world = new VoxelWorld();
  world.generateOnAccess = false;
  for (const [x, y, z] of [[0, 0, 0], [15, 15, 15], [16, 0, 0], [-1, -1, -1], [-17, 5, 33]]) {
    world.setVoxel(x, y, z, MATERIAL_ID.Rock);
    assert.equal(world.getVoxel(x, y, z), MATERIAL_ID.Rock, `at ${x},${y},${z}`);
  }
});

test("solidCount tracks fills and clears", () => {
  const chunk = new Chunk(0, 0, 0);
  assert.ok(chunk.isEmpty);
  chunk.set(1, 2, 3, MATERIAL_ID.Grass);
  assert.equal(chunk.solidCount, 1);
  chunk.set(1, 2, 3, 0);
  assert.equal(chunk.solidCount, 0);
  assert.ok(chunk.isEmpty);
});

test("RLE round-trips an arbitrary chunk", () => {
  const chunk = new Chunk(0, 0, 0);
  // A mix of long runs and scattered singles, the realistic worst case.
  chunk.data.fill(MATERIAL_ID.Slate, 0, 1000);
  for (let i = 1000; i < 1200; i += 3) chunk.data[i] = MATERIAL_ID.Sand;
  chunk.data.fill(MATERIAL_ID.Grass, 3000, CHUNK_VOLUME);
  const decoded = decodeChunkRLE(encodeChunkRLE(chunk));
  assert.deepEqual([...decoded], [...chunk.data]);
});

test("RLE handles runs longer than one byte", () => {
  const chunk = new Chunk(0, 0, 0);
  chunk.data.fill(MATERIAL_ID.Rock);
  const encoded = encodeChunkRLE(chunk);
  const decoded = decodeChunkRLE(encoded);
  assert.equal(decoded.length, CHUNK_VOLUME);
  assert.ok(decoded.every((v) => v === MATERIAL_ID.Rock));
  // 4096 identical voxels should compress to a handful of bytes.
  assert.ok(encoded.length < 64, `expected tiny payload, got ${encoded.length}`);
});

test("generation is deterministic for a seed", () => {
  const a = new VoxelWorld({ seed: 42 });
  const b = new VoxelWorld({ seed: 42 });
  const c = new VoxelWorld({ seed: 43 });
  assert.equal(a.surfaceHeight(100, -250), b.surfaceHeight(100, -250));
  assert.notEqual(a.surfaceHeight(100, -250), c.surfaceHeight(100, -250));
  const ca = a.getChunk(0, 0, 0);
  const cb = b.getChunk(0, 0, 0);
  assert.deepEqual([...ca.data], [...cb.data]);
});

test("heightAt finds the generated surface", () => {
  const world = new VoxelWorld({ seed: 7 });
  const surface = world.surfaceHeight(0, 0);
  const found = world.heightAt(0, 0, 400);
  assert.ok(Number.isFinite(found), "expected solid ground at the origin column");
  assert.ok(
    Math.abs(found - surface) <= VOXEL_SIZE * 2,
    `heightAt ${found} should be near surfaceHeight ${surface}`,
  );
});

test("voxel raycast hits the nearest solid and reports its face", () => {
  const world = new VoxelWorld();
  world.generateOnAccess = false;
  world.setVoxel(5, 0, 0, MATERIAL_ID.Rock);
  const hit = world.raycast(new Vector3(0, 2, 2), new Vector3(1, 0, 0), 200);
  assert.ok(hit, "expected a hit");
  assert.deepEqual(hit.voxel, [5, 0, 0]);
  assert.equal(hit.normal.x, -1);
});

test("voxel raycast misses empty space", () => {
  const world = new VoxelWorld();
  world.generateOnAccess = false;
  assert.equal(world.raycast(new Vector3(0, 0, 0), new Vector3(0, 1, 0), 100), null);
});

test("fillBall carves a sphere and marks chunks dirty", () => {
  const world = new VoxelWorld();
  world.generateOnAccess = false;
  const changed = world.fillBall(new Vector3(0, 0, 0), 12, MATERIAL_ID.Sand);
  assert.ok(changed > 0);
  assert.equal(world.getVoxel(0, 0, 0), MATERIAL_ID.Sand);
  assert.ok(world.dirtyChunks.size > 0);
});

test("water is not treated as solid ground", () => {
  const world = new VoxelWorld();
  world.generateOnAccess = false;
  world.setVoxel(0, 0, 0, MATERIAL_ID.Water);
  assert.equal(world.isSolidAt(new Vector3(2, 2, 2)), false);
});

// ---------------------------------------------------------------------------
// The density field behind smooth terrain
// ---------------------------------------------------------------------------

test("occupancy defaults to full for a plain material write", () => {
  const world = new VoxelWorld();
  world.generateOnAccess = false;
  world.setVoxel(0, 0, 0, MATERIAL_ID.Rock);
  assert.equal(world.getOccupancy(0, 0, 0), 255);
  world.setVoxel(0, 0, 0, MATERIAL_ID.Rock, 128);
  assert.equal(world.getOccupancy(0, 0, 0), 128);
});

test("clearing a voxel clears its occupancy", () => {
  const world = new VoxelWorld();
  world.generateOnAccess = false;
  world.setVoxel(1, 1, 1, MATERIAL_ID.Rock);
  world.setVoxel(1, 1, 1, 0);
  assert.equal(world.getOccupancy(1, 1, 1), 0);
});

test("a change in occupancy alone still counts as a change", () => {
  const world = new VoxelWorld();
  world.generateOnAccess = false;
  world.setVoxel(2, 2, 2, MATERIAL_ID.Rock, 255);
  assert.equal(world.setVoxel(2, 2, 2, MATERIAL_ID.Rock, 255), false, "no-op");
  assert.equal(world.setVoxel(2, 2, 2, MATERIAL_ID.Rock, 100), true, "density changed");
});

test("generated terrain produces partial occupancy at the surface", () => {
  const world = new VoxelWorld({ seed: 11 });
  // Walk a column through the surface; at least one voxel should be partly
  // filled, which is what lets the mesher round the hill off.
  let partial = 0;
  for (let vy = 0; vy < 40; vy++) {
    const occ = world.getOccupancy(0, vy, 0);
    if (occ > 0 && occ < 255) partial++;
  }
  assert.ok(partial > 0, "expected a partly filled voxel at the surface");
});

test("densityAt interpolates between voxels", () => {
  const world = new VoxelWorld();
  world.generateOnAccess = false;
  // Two neighbouring voxels, one full and one empty.
  world.setVoxel(0, 0, 0, MATERIAL_ID.Rock, 255);
  world.setVoxel(1, 0, 0, MATERIAL_ID.Rock, 0);

  const centreOfFull = world.densityAt(VOXEL_SIZE * 0.5, VOXEL_SIZE * 0.5, VOXEL_SIZE * 0.5);
  const midway = world.densityAt(VOXEL_SIZE * 1.0, VOXEL_SIZE * 0.5, VOXEL_SIZE * 0.5);
  assert.ok(centreOfFull > 0.9, `expected solid at the centre, got ${centreOfFull}`);
  assert.ok(
    midway > 0.3 && midway < 0.7,
    `expected an interpolated value between voxels, got ${midway}`,
  );
});

test("the density gradient points out of the terrain", () => {
  const world = new VoxelWorld({ seed: 3 });
  const surface = world.surfaceHeight(0, 0);
  const gradient = world.densityGradient(0, surface, 0);
  assert.ok(gradient.y > 0, `expected an upward gradient at the surface, got ${gradient.y}`);
});

test("a half-full voxel is not solid ground", () => {
  const world = new VoxelWorld();
  world.generateOnAccess = false;
  world.setVoxel(0, 0, 0, MATERIAL_ID.Rock, 60);
  assert.equal(world.isSolidAt(new Vector3(2, 2, 2)), false, "a sliver is not standable");
  world.setVoxel(0, 0, 0, MATERIAL_ID.Rock, 200);
  assert.equal(world.isSolidAt(new Vector3(2, 2, 2)), true);
});

test("fillBall feathers its edge instead of producing a ball of cubes", () => {
  const world = new VoxelWorld();
  world.generateOnAccess = false;
  world.fillBall(new Vector3(32, 32, 32), 16, MATERIAL_ID.Sand);

  let partial = 0;
  let full = 0;
  for (let vy = 4; vy <= 12; vy++) {
    for (let vx = 4; vx <= 12; vx++) {
      const occ = world.getOccupancy(vx, vy, 8);
      if (occ === 255) full++;
      else if (occ > 0) partial++;
    }
  }
  assert.ok(full > 0, "the middle should be solid");
  assert.ok(partial > 0, "the rim should be partly filled");
});

test("carving with air removes density gradually", () => {
  const world = new VoxelWorld();
  world.generateOnAccess = false;
  world.fillBall(new Vector3(32, 32, 32), 20, MATERIAL_ID.Rock);
  const before = world.getOccupancy(8, 8, 8);
  world.fillBall(new Vector3(32, 32, 32), 12, 0);
  assert.ok(before > 0);
  assert.equal(world.getOccupancy(8, 8, 8), 0, "the centre should be fully carved");
});

test("chunk serialization round-trips occupancy", () => {
  const chunk = new Chunk(0, 0, 0);
  chunk.set(1, 2, 3, MATERIAL_ID.Rock, 120);
  chunk.set(4, 5, 6, MATERIAL_ID.Grass, 255);
  const decoded = decodeChunkPlanes(encodeChunkRLE(chunk));
  assert.deepEqual([...decoded.data], [...chunk.data]);
  assert.deepEqual([...decoded.occupancy], [...chunk.occupancy]);
});

test("a payload without an occupancy plane is treated as fully solid", () => {
  // Forward compatibility in reverse: older saves carried materials only.
  const chunk = new Chunk(0, 0, 0);
  chunk.set(0, 0, 0, MATERIAL_ID.Rock);
  const bytes = Buffer.from(encodeChunkRLE(chunk), "base64");
  // Keep only the first plane, as an older encoder would have written.
  const materialsOnly = bytes.subarray(0, bytes.length / 2).toString("base64");
  const decoded = decodeChunkPlanes(materialsOnly);
  for (let i = 0; i < decoded.data.length; i++) {
    if (decoded.data[i] !== 0) assert.equal(decoded.occupancy[i], 255);
  }
});
