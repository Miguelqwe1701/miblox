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
