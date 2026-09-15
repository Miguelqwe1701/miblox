import { Vector3 } from "./math.js";
import { fbm2, fbm3 } from "./noise.js";

/** Studs per voxel. Matches Roblox's 4-stud terrain grid. */
export const VOXEL_SIZE = 4;
/** Voxels per chunk edge. 16^3 = 4096 bytes per chunk, a convenient wire unit. */
export const CHUNK_SIZE = 16;
export const CHUNK_VOLUME = CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE;
/** Studs per chunk edge. */
export const CHUNK_STUDS = CHUNK_SIZE * VOXEL_SIZE;

/** Voxel material ids. 0 is always empty; the rest index MATERIAL_BY_ID. */
export const AIR = 0;
export const MATERIAL_BY_ID = [
  "Air",
  "Grass",
  "Rock",
  "Sand",
  "Snow",
  "Water",
  "Wood",
  "Concrete",
  "Brick",
  "Slate",
  "Ice",
  "Metal",
] as const;

export const MATERIAL_ID: Record<string, number> = Object.fromEntries(
  MATERIAL_BY_ID.map((name, i) => [name, i]),
);

export type ChunkKey = string;

export function chunkKey(cx: number, cy: number, cz: number): ChunkKey {
  return `${cx},${cy},${cz}`;
}

export function parseChunkKey(key: ChunkKey): [number, number, number] {
  const [x, y, z] = key.split(",");
  return [Number(x), Number(y), Number(z)];
}

/** One 16^3 block of voxels. `empty` short-circuits meshing and replication. */
export class Chunk {
  readonly data: Uint8Array;
  /** Bumped on every write so clients can skip unchanged chunks. */
  version = 0;
  solidCount = 0;

  constructor(
    readonly cx: number,
    readonly cy: number,
    readonly cz: number,
    data?: Uint8Array,
  ) {
    this.data = data ?? new Uint8Array(CHUNK_VOLUME);
    if (data) for (const v of data) if (v !== AIR) this.solidCount++;
  }

  get key(): ChunkKey {
    return chunkKey(this.cx, this.cy, this.cz);
  }

  get isEmpty(): boolean {
    return this.solidCount === 0;
  }

  static index(lx: number, ly: number, lz: number): number {
    return (ly * CHUNK_SIZE + lz) * CHUNK_SIZE + lx;
  }

  get(lx: number, ly: number, lz: number): number {
    return this.data[Chunk.index(lx, ly, lz)];
  }

  set(lx: number, ly: number, lz: number, material: number): boolean {
    const i = Chunk.index(lx, ly, lz);
    const prev = this.data[i];
    if (prev === material) return false;
    if (prev === AIR && material !== AIR) this.solidCount++;
    else if (prev !== AIR && material === AIR) this.solidCount--;
    this.data[i] = material;
    this.version++;
    return true;
  }

  clone(): Chunk {
    return new Chunk(this.cx, this.cy, this.cz, this.data.slice());
  }
}

export function worldToVoxel(p: Vector3): [number, number, number] {
  return [
    Math.floor(p.x / VOXEL_SIZE),
    Math.floor(p.y / VOXEL_SIZE),
    Math.floor(p.z / VOXEL_SIZE),
  ];
}

export function voxelToWorld(vx: number, vy: number, vz: number): Vector3 {
  return new Vector3(vx * VOXEL_SIZE, vy * VOXEL_SIZE, vz * VOXEL_SIZE);
}

function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

function mod(a: number, b: number): number {
  return ((a % b) + b) % b;
}

export interface TerrainGenOptions {
  seed: number;
  /** Base ground height in studs. */
  seaLevel: number;
  /** Peak-to-trough amplitude in studs. */
  amplitude: number;
  /** Horizontal feature scale; larger means broader hills. */
  scale: number;
  caves: boolean;
}

export const DEFAULT_TERRAIN_GEN: TerrainGenOptions = {
  seed: 1337,
  seaLevel: 24,
  amplitude: 56,
  scale: 180,
  caves: true,
};

/**
 * Sparse voxel world. Chunks are created lazily, and generated on demand from
 * the seed so the server never has to ship an authored heightmap.
 */
export class VoxelWorld {
  private chunks = new Map<ChunkKey, Chunk>();
  /** Chunks whose contents changed since the last replication flush. */
  readonly dirtyChunks = new Set<ChunkKey>();
  gen: TerrainGenOptions;
  /** Chunks below this Y are generated as ground; above, as air. */
  generateOnAccess = true;

  constructor(gen: Partial<TerrainGenOptions> = {}) {
    this.gen = { ...DEFAULT_TERRAIN_GEN, ...gen };
  }

  get chunkCount(): number {
    return this.chunks.size;
  }

  allChunks(): IterableIterator<Chunk> {
    return this.chunks.values();
  }

  getChunk(cx: number, cy: number, cz: number, create = false): Chunk | undefined {
    const key = chunkKey(cx, cy, cz);
    let chunk = this.chunks.get(key);
    if (!chunk && (create || this.generateOnAccess)) {
      chunk = new Chunk(cx, cy, cz);
      if (this.generateOnAccess) this.generateChunk(chunk);
      this.chunks.set(key, chunk);
      if (!chunk.isEmpty) this.dirtyChunks.add(key);
    }
    return chunk;
  }

  hasChunk(cx: number, cy: number, cz: number): boolean {
    return this.chunks.has(chunkKey(cx, cy, cz));
  }

  putChunk(chunk: Chunk): void {
    this.chunks.set(chunk.key, chunk);
    this.dirtyChunks.add(chunk.key);
  }

  getVoxel(vx: number, vy: number, vz: number): number {
    const chunk = this.getChunk(
      floorDiv(vx, CHUNK_SIZE),
      floorDiv(vy, CHUNK_SIZE),
      floorDiv(vz, CHUNK_SIZE),
    );
    if (!chunk) return AIR;
    return chunk.get(mod(vx, CHUNK_SIZE), mod(vy, CHUNK_SIZE), mod(vz, CHUNK_SIZE));
  }

  setVoxel(vx: number, vy: number, vz: number, material: number): boolean {
    const chunk = this.getChunk(
      floorDiv(vx, CHUNK_SIZE),
      floorDiv(vy, CHUNK_SIZE),
      floorDiv(vz, CHUNK_SIZE),
      true,
    );
    if (!chunk) return false;
    const changed = chunk.set(
      mod(vx, CHUNK_SIZE),
      mod(vy, CHUNK_SIZE),
      mod(vz, CHUNK_SIZE),
      material,
    );
    if (changed) {
      this.dirtyChunks.add(chunk.key);
      // A face on a chunk border changes the neighbour's visible surface too.
      this.markNeighbours(vx, vy, vz);
    }
    return changed;
  }

  private markNeighbours(vx: number, vy: number, vz: number): void {
    const lx = mod(vx, CHUNK_SIZE);
    const ly = mod(vy, CHUNK_SIZE);
    const lz = mod(vz, CHUNK_SIZE);
    const cx = floorDiv(vx, CHUNK_SIZE);
    const cy = floorDiv(vy, CHUNK_SIZE);
    const cz = floorDiv(vz, CHUNK_SIZE);
    if (lx === 0) this.touch(cx - 1, cy, cz);
    if (lx === CHUNK_SIZE - 1) this.touch(cx + 1, cy, cz);
    if (ly === 0) this.touch(cx, cy - 1, cz);
    if (ly === CHUNK_SIZE - 1) this.touch(cx, cy + 1, cz);
    if (lz === 0) this.touch(cx, cy, cz - 1);
    if (lz === CHUNK_SIZE - 1) this.touch(cx, cy, cz + 1);
  }

  private touch(cx: number, cy: number, cz: number): void {
    if (this.chunks.has(chunkKey(cx, cy, cz))) this.dirtyChunks.add(chunkKey(cx, cy, cz));
  }

  isSolidAt(p: Vector3): boolean {
    const [vx, vy, vz] = worldToVoxel(p);
    const m = this.getVoxel(vx, vy, vz);
    return m !== AIR && m !== MATERIAL_ID.Water;
  }

  /** Fills an axis-aligned region in studs. Returns voxels changed. */
  fillBlock(min: Vector3, max: Vector3, material: number): number {
    const [x0, y0, z0] = worldToVoxel(min);
    const [x1, y1, z1] = worldToVoxel(max.sub(new Vector3(0.001, 0.001, 0.001)));
    let n = 0;
    for (let y = y0; y <= y1; y++)
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++) if (this.setVoxel(x, y, z, material)) n++;
    return n;
  }

  fillBall(center: Vector3, radius: number, material: number): number {
    const r = Math.ceil(radius / VOXEL_SIZE);
    const [cx, cy, cz] = worldToVoxel(center);
    const r2 = r * r;
    let n = 0;
    for (let y = -r; y <= r; y++)
      for (let z = -r; z <= r; z++)
        for (let x = -r; x <= r; x++) {
          if (x * x + y * y + z * z > r2) continue;
          if (this.setVoxel(cx + x, cy + y, cz + z, material)) n++;
        }
    return n;
  }

  /** Height in studs of the highest solid voxel at a column, or -Infinity. */
  heightAt(x: number, z: number, searchFrom = 256): number {
    const vx = Math.floor(x / VOXEL_SIZE);
    const vz = Math.floor(z / VOXEL_SIZE);
    for (let vy = Math.floor(searchFrom / VOXEL_SIZE); vy >= -16; vy--) {
      const m = this.getVoxel(vx, vy, vz);
      if (m !== AIR && m !== MATERIAL_ID.Water) return (vy + 1) * VOXEL_SIZE;
    }
    return -Infinity;
  }

  /** Terrain surface height in studs at a world XZ, straight from the seed. */
  surfaceHeight(x: number, z: number): number {
    const g = this.gen;
    const base = fbm2(x / g.scale, z / g.scale, g.seed, 5);
    // Ridged term adds mountain spines without overwhelming the rolling hills.
    const ridge = 1 - Math.abs(fbm2(x / (g.scale * 0.45), z / (g.scale * 0.45), g.seed + 51, 3) * 2 - 1);
    const h = base * 0.75 + ridge * ridge * 0.25;
    return g.seaLevel + (h - 0.5) * g.amplitude;
  }

  private generateChunk(chunk: Chunk): void {
    const g = this.gen;
    const baseX = chunk.cx * CHUNK_SIZE;
    const baseY = chunk.cy * CHUNK_SIZE;
    const baseZ = chunk.cz * CHUNK_SIZE;
    const chunkMinY = baseY * VOXEL_SIZE;
    // Cheap rejection: whole chunk is above the tallest possible surface.
    if (chunkMinY > g.seaLevel + g.amplitude + CHUNK_STUDS) return;

    const waterId = MATERIAL_ID.Water;
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const wx = (baseX + lx) * VOXEL_SIZE;
        const wz = (baseZ + lz) * VOXEL_SIZE;
        const surface = this.surfaceHeight(wx, wz);
        for (let ly = 0; ly < CHUNK_SIZE; ly++) {
          const wy = (baseY + ly) * VOXEL_SIZE;
          let material = AIR;
          if (wy < surface) {
            const depth = surface - wy;
            if (depth < VOXEL_SIZE * 1.5) {
              material =
                surface > g.seaLevel + g.amplitude * 0.28
                  ? MATERIAL_ID.Snow
                  : surface < g.seaLevel * 0.6
                    ? MATERIAL_ID.Sand
                    : MATERIAL_ID.Grass;
            } else if (depth < VOXEL_SIZE * 5) {
              material = MATERIAL_ID.Rock;
            } else {
              material = MATERIAL_ID.Slate;
            }
            if (g.caves && depth > VOXEL_SIZE * 2) {
              const cave = fbm3(wx / 70, wy / 45, wz / 70, g.seed + 991, 3);
              if (cave > 0.62) material = AIR;
            }
          } else if (wy < g.seaLevel * 0.55) {
            material = waterId;
          }
          if (material !== AIR) {
            chunk.data[Chunk.index(lx, ly, lz)] = material;
            chunk.solidCount++;
          }
        }
      }
    }
    chunk.version++;
  }

  /** Voxel DDA raycast. Returns the hit voxel and the face normal. */
  raycast(
    origin: Vector3,
    direction: Vector3,
    maxDistance = 512,
    ignoreWater = true,
  ): { position: Vector3; normal: Vector3; voxel: [number, number, number]; material: number } | null {
    const dir = direction.unit;
    if (dir.magnitude === 0) return null;
    let [vx, vy, vz] = worldToVoxel(origin);
    const step = [Math.sign(dir.x), Math.sign(dir.y), Math.sign(dir.z)];
    const invDir = [
      dir.x === 0 ? Infinity : VOXEL_SIZE / Math.abs(dir.x),
      dir.y === 0 ? Infinity : VOXEL_SIZE / Math.abs(dir.y),
      dir.z === 0 ? Infinity : VOXEL_SIZE / Math.abs(dir.z),
    ];
    // Distance along the ray to the first voxel boundary on each axis. An axis
    // with zero direction never crosses a boundary, so its tMax stays Infinity
    // (computing it as a ratio would give NaN and poison every comparison).
    const firstBoundary = (o: number, v: number, s: number, d: number): number => {
      if (s === 0) return Infinity;
      const dist = s > 0 ? (v + 1) * VOXEL_SIZE - o : o - v * VOXEL_SIZE;
      return dist / Math.abs(d);
    };
    const tMax = [
      firstBoundary(origin.x, vx, step[0], dir.x),
      firstBoundary(origin.y, vy, step[1], dir.y),
      firstBoundary(origin.z, vz, step[2], dir.z),
    ];
    let t = 0;
    let normal = Vector3.zero;
    for (let guard = 0; guard < 4096 && t <= maxDistance; guard++) {
      const m = this.getVoxel(vx, vy, vz);
      if (m !== AIR && !(ignoreWater && m === MATERIAL_ID.Water)) {
        return {
          position: origin.add(dir.mul(t)),
          normal,
          voxel: [vx, vy, vz],
          material: m,
        };
      }
      if (tMax[0] < tMax[1] && tMax[0] < tMax[2]) {
        vx += step[0];
        t = tMax[0];
        tMax[0] += invDir[0];
        normal = new Vector3(-step[0], 0, 0);
      } else if (tMax[1] < tMax[2]) {
        vy += step[1];
        t = tMax[1];
        tMax[1] += invDir[1];
        normal = new Vector3(0, -step[1], 0);
      } else {
        vz += step[2];
        t = tMax[2];
        tMax[2] += invDir[2];
        normal = new Vector3(0, 0, -step[2]);
      }
    }
    return null;
  }
}
