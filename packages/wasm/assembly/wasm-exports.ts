/**
 * WebAssembly entry module.
 *
 * WASM can only hand plain numbers across the boundary, so instead of passing
 * arrays the host asks for the address of each buffer once and then reads and
 * writes linear memory directly. Kept separate from mesher.ts because
 * `.dataStart` is an AssemblyScript concept that the JavaScript build of the
 * mesher cannot use.
 */
import {
  CHUNK,
  FLOATS_PER_VERTEX,
  PAD,
  clearVoxels,
  getIndexCount,
  getOverflowed,
  getMaxQuads,
  getVertexCount,
  indices,
  meshChunk,
  vertices,
  voxels,
  occupancy,
  meshChunkSmooth,
} from "./mesher";

/** Address of the padded voxel input buffer (PAD^3 bytes). */
export function voxelsPtr(): usize {
  return voxels.dataStart;
}

/** Address of the interleaved vertex output buffer. */
export function verticesPtr(): usize {
  return vertices.dataStart;
}

/** Address of the index output buffer. */
export function indicesPtr(): usize {
  return indices.dataStart;
}

export function mesh(solidPass: i32): i32 {
  return meshChunk(solidPass);
}

export function vertexCount(): i32 {
  return getVertexCount();
}

export function indexCount(): i32 {
  return getIndexCount();
}

export function clear(): void {
  clearVoxels();
}

/** Layout constants, so the host never hard-codes them twice. */
export function chunkSize(): i32 {
  return CHUNK;
}

export function paddedSize(): i32 {
  return PAD;
}

export function floatsPerVertex(): i32 {
  return FLOATS_PER_VERTEX;
}

/** True when the last mesh ran out of output space. */
export function overflowed(): bool {
  return getOverflowed();
}

export function maxQuads(): i32 {
  return getMaxQuads();
}

/** Address of the padded occupancy buffer (PAD^3 bytes). */
export function occupancyPtr(): usize {
  return occupancy.dataStart;
}

export function meshSmooth(solidPass: i32): i32 {
  return meshChunkSmooth(solidPass);
}
