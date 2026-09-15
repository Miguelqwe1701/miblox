import * as js from "../assembly/mesher.js";

export const CHUNK = js.CHUNK;
export const PAD = js.PAD;
export const FLOATS_PER_VERTEX = js.FLOATS_PER_VERTEX;
export const PADDED_VOLUME = PAD * PAD * PAD;

/** Vertex attribute layout, in floats, within the interleaved buffer. */
export const VERTEX_LAYOUT = {
  position: { offset: 0, size: 3 },
  normal: { offset: 3, size: 3 },
  uv: { offset: 6, size: 2 },
  material: { offset: 8, size: 1 },
  occlusion: { offset: 9, size: 1 },
} as const;

export interface ChunkMesh {
  /** Interleaved vertex data; `vertexCount * FLOATS_PER_VERTEX` floats. */
  vertices: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
  indexCount: number;
  quadCount: number;
}

export interface Mesher {
  /** Which implementation is in use, for diagnostics and tests. */
  readonly backend: "wasm" | "js";
  /**
   * Meshes one chunk.
   *
   * `padded` is a PAD^3 byte volume: the chunk's own 16^3 voxels surrounded by
   * one voxel of its neighbours' data, so faces on a chunk boundary are only
   * emitted where they are genuinely exposed. `solidPass` is 1 for opaque
   * materials and 0 for water, which is drawn translucent in a second pass.
   *
   * The returned arrays are copies, so the caller may keep them.
   */
  meshChunk(padded: Uint8Array, solidPass?: number): ChunkMesh;
}

interface WasmExports {
  memory: WebAssembly.Memory;
  voxelsPtr(): number;
  verticesPtr(): number;
  indicesPtr(): number;
  mesh(solidPass: number): number;
  vertexCount(): number;
  indexCount(): number;
  clear(): void;
  overflowed(): number;
  maxQuads(): number;
  chunkSize(): number;
  paddedSize(): number;
  floatsPerVertex(): number;
}

class WasmMesher implements Mesher {
  readonly backend = "wasm" as const;
  private readonly voxels: Uint8Array;

  constructor(private readonly exports: WasmExports) {
    const buffer = exports.memory.buffer;
    this.voxels = new Uint8Array(buffer, exports.voxelsPtr(), PADDED_VOLUME);
    if (exports.paddedSize() !== PAD || exports.floatsPerVertex() !== FLOATS_PER_VERTEX) {
      throw new Error("WASM module layout does not match the JavaScript constants");
    }
  }

  meshChunk(padded: Uint8Array, solidPass = 1): ChunkMesh {
    if (padded.length !== PADDED_VOLUME) {
      throw new Error(`padded volume must be ${PADDED_VOLUME} bytes, got ${padded.length}`);
    }
    this.voxels.set(padded);
    const quadCount = this.exports.mesh(solidPass);
    if (this.exports.overflowed()) {
      throw new Error(
        `chunk mesh exceeded ${this.exports.maxQuads()} quads; the output buffers are too small`,
      );
    }
    const vertexCount = this.exports.vertexCount();
    const indexCount = this.exports.indexCount();
    // Views are rebuilt each call: a memory.grow would detach the old buffer.
    const buffer = this.exports.memory.buffer;
    const vertices = new Float32Array(
      buffer,
      this.exports.verticesPtr(),
      vertexCount * FLOATS_PER_VERTEX,
    ).slice();
    const indices = new Uint32Array(buffer, this.exports.indicesPtr(), indexCount).slice();
    return { vertices, indices, vertexCount, indexCount, quadCount };
  }
}

class JsMesher implements Mesher {
  readonly backend = "js" as const;

  meshChunk(padded: Uint8Array, solidPass = 1): ChunkMesh {
    if (padded.length !== PADDED_VOLUME) {
      throw new Error(`padded volume must be ${PADDED_VOLUME} bytes, got ${padded.length}`);
    }
    js.voxels.set(padded);
    const quadCount = js.meshChunk(solidPass);
    if (js.getOverflowed()) {
      throw new Error(
        `chunk mesh exceeded ${js.getMaxQuads()} quads; the output buffers are too small`,
      );
    }
    const vertexCount = js.getVertexCount();
    const indexCount = js.getIndexCount();
    return {
      vertices: js.vertices.slice(0, vertexCount * FLOATS_PER_VERTEX),
      indices: js.indices.slice(0, indexCount),
      vertexCount,
      indexCount,
      quadCount,
    };
  }
}

/** The JS implementation. Always available, and used when WASM cannot load. */
export function createJsMesher(): Mesher {
  return new JsMesher();
}

export async function createWasmMesher(
  source: BufferSource | WebAssembly.Module,
): Promise<Mesher> {
  const imports = {
    env: {
      // Reached only on a trap, which would mean a bug in the mesher itself.
      abort(_msg: number, _file: number, line: number, column: number) {
        throw new Error(`miblox.wasm aborted at ${line}:${column}`);
      },
    },
  };
  const instance =
    source instanceof WebAssembly.Module
      ? await WebAssembly.instantiate(source, imports)
      : (await WebAssembly.instantiate(source, imports)).instance;
  return new WasmMesher(instance.exports as unknown as WasmExports);
}

/**
 * Loads the WASM mesher, falling back to the JavaScript build if anything goes
 * wrong. Both produce identical geometry, so the fallback costs frame time but
 * never correctness.
 */
export async function createMesher(
  source?: BufferSource | WebAssembly.Module,
  onFallback?: (reason: unknown) => void,
): Promise<Mesher> {
  if (!source) return createJsMesher();
  try {
    if (typeof WebAssembly === "undefined") throw new Error("WebAssembly unavailable");
    return await createWasmMesher(source);
  } catch (err) {
    onFallback?.(err);
    return createJsMesher();
  }
}

/**
 * Fills a padded volume from a callback. The callback receives chunk-local
 * coordinates from -1 to CHUNK inclusive and returns a material id.
 */
export function packPadded(
  out: Uint8Array,
  sample: (x: number, y: number, z: number) => number,
): Uint8Array {
  for (let y = -1; y <= CHUNK; y++) {
    for (let z = -1; z <= CHUNK; z++) {
      for (let x = -1; x <= CHUNK; x++) {
        out[(y + 1) * PAD * PAD + (z + 1) * PAD + (x + 1)] = sample(x, y, z);
      }
    }
  }
  return out;
}

export function newPaddedVolume(): Uint8Array {
  return new Uint8Array(PADDED_VOLUME);
}
