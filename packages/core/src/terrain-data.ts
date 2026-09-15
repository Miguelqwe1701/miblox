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

/**
 * One 16^3 block of voxels.
 *
 * Two parallel arrays: the material id, and how full the voxel is. Occupancy
 * is what makes the terrain smooth rather than blocky - it is the scalar field
 * the surface is extracted from, so a half-full voxel produces a surface
 * halfway through it instead of a cube face on its boundary.
 */
export class Chunk {
  readonly data: Uint8Array;
  /** 0 = empty, 255 = completely solid. */
  readonly occupancy: Uint8Array;
  /** Bumped on every write so clients can skip unchanged chunks. */
  version = 0;
  solidCount = 0;

  constructor(
    readonly cx: number,
    readonly cy: number,
    readonly cz: number,
    data?: Uint8Array,
    occupancy?: Uint8Array,
  ) {
    this.data = data ?? new Uint8Array(CHUNK_VOLUME);
    this.occupancy = occupancy ?? new Uint8Array(CHUNK_VOLUME);
    if (data) {
      for (let i = 0; i < CHUNK_VOLUME; i++) {
        if (this.data[i] === AIR) continue;
        this.solidCount++;
        // A chunk restored without occupancy is fully solid where it has a
        // material, which is what an authored blocky edit means.
        if (!occupancy) this.occupancy[i] = 255;
      }
    }
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

  getOccupancy(lx: number, ly: number, lz: number): number {
    return this.occupancy[Chunk.index(lx, ly, lz)];
  }

  set(lx: number, ly: number, lz: number, material: number, occupancy = -1): boolean {
    const i = Chunk.index(lx, ly, lz);
    // A caller that does not say how full the voxel is means "all or nothing".
    const nextOccupancy = occupancy >= 0 ? occupancy : material === AIR ? 0 : 255;
    const prev = this.data[i];
    if (prev === material && this.occupancy[i] === nextOccupancy) return false;
    if (prev === AIR && material !== AIR) this.solidCount++;
    else if (prev !== AIR && material === AIR) this.solidCount--;
    this.data[i] = material;
    this.occupancy[i] = nextOccupancy;
    this.version++;
    return true;
  }

  clone(): Chunk {
    return new Chunk(this.cx, this.cy, this.cz, this.data.slice(), this.occupancy.slice());
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

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
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

  getOccupancy(vx: number, vy: number, vz: number): number {
    const chunk = this.getChunk(
      floorDiv(vx, CHUNK_SIZE),
      floorDiv(vy, CHUNK_SIZE),
      floorDiv(vz, CHUNK_SIZE),
    );
    if (!chunk) return 0;
    return chunk.getOccupancy(mod(vx, CHUNK_SIZE), mod(vy, CHUNK_SIZE), mod(vz, CHUNK_SIZE));
  }

  setVoxel(vx: number, vy: number, vz: number, material: number, occupancy = -1): boolean {
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
      occupancy,
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

  /** The occupancy at which a voxel counts as solid ground. */
  static readonly SOLID_THRESHOLD = 128;

  isSolidAt(p: Vector3): boolean {
    const [vx, vy, vz] = worldToVoxel(p);
    const m = this.getVoxel(vx, vy, vz);
    if (m === AIR || m === MATERIAL_ID.Water) return false;
    return this.getOccupancy(vx, vy, vz) >= VoxelWorld.SOLID_THRESHOLD;
  }

  /**
   * Trilinearly interpolated density at a world position, in 0..1.
   *
   * This is the same field the smooth mesher contours, so physics and the
   * visible surface agree instead of the player standing on an invisible
   * blocky approximation of a smooth hill.
   */
  densityAt(x: number, y: number, z: number, includeWater = false): number {
    // Samples sit at voxel centres, so shift by half a voxel before flooring.
    const fx = x / VOXEL_SIZE - 0.5;
    const fy = y / VOXEL_SIZE - 0.5;
    const fz = z / VOXEL_SIZE - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const z0 = Math.floor(fz);
    const tx = fx - x0;
    const ty = fy - y0;
    const tz = fz - z0;

    const sample = (ix: number, iy: number, iz: number): number => {
      const m = this.getVoxel(ix, iy, iz);
      if (m === AIR) return 0;
      if (!includeWater && m === MATERIAL_ID.Water) return 0;
      return this.getOccupancy(ix, iy, iz) / 255;
    };

    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
    const c00 = lerp(sample(x0, y0, z0), sample(x0 + 1, y0, z0), tx);
    const c10 = lerp(sample(x0, y0 + 1, z0), sample(x0 + 1, y0 + 1, z0), tx);
    const c01 = lerp(sample(x0, y0, z0 + 1), sample(x0 + 1, y0, z0 + 1), tx);
    const c11 = lerp(sample(x0, y0 + 1, z0 + 1), sample(x0 + 1, y0 + 1, z0 + 1), tx);
    return lerp(lerp(c00, c10, ty), lerp(c01, c11, ty), tz);
  }

  /** Gradient of the density field, pointing out of the terrain. */
  densityGradient(x: number, y: number, z: number): Vector3 {
    const h = VOXEL_SIZE * 0.5;
    return new Vector3(
      this.densityAt(x - h, y, z) - this.densityAt(x + h, y, z),
      this.densityAt(x, y - h, z) - this.densityAt(x, y + h, z),
      this.densityAt(x, y, z - h) - this.densityAt(x, y, z + h),
    );
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

  /**
   * Fills a sphere, feathering the edge across one voxel so the resulting
   * surface is smooth rather than a ball of cubes.
   */
  fillBall(center: Vector3, radius: number, material: number): number {
    const r = Math.ceil(radius / VOXEL_SIZE) + 1;
    const [cx, cy, cz] = worldToVoxel(center);
    let n = 0;
    for (let y = -r; y <= r; y++)
      for (let z = -r; z <= r; z++)
        for (let x = -r; x <= r; x++) {
          const vx = cx + x;
          const vy = cy + y;
          const vz = cz + z;
          // Distance from the sphere's surface, in voxels.
          const centre = voxelToWorld(vx, vy, vz).add(
            new Vector3(VOXEL_SIZE / 2, VOXEL_SIZE / 2, VOXEL_SIZE / 2),
          );
          const distance = centre.sub(center).magnitude;
          const coverage = clamp01((radius - distance) / VOXEL_SIZE + 0.5);
          if (coverage <= 0) continue;

          if (material === AIR) {
            // Carving removes coverage from whatever is already there.
            const existing = this.getOccupancy(vx, vy, vz);
            const remaining = Math.round(existing * (1 - coverage));
            const existingMaterial = this.getVoxel(vx, vy, vz);
            if (existingMaterial === AIR) continue;
            if (this.setVoxel(vx, vy, vz, remaining === 0 ? AIR : existingMaterial, remaining)) n++;
            continue;
          }

          const occupancy = Math.round(coverage * 255);
          if (occupancy <= this.getOccupancy(vx, vy, vz) && this.getVoxel(vx, vy, vz) === material) {
            continue;
          }
          if (this.setVoxel(vx, vy, vz, material, Math.max(occupancy, this.getOccupancy(vx, vy, vz)))) {
            n++;
          }
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
          let occupancy = 0;

          // How much of this voxel sits below the surface, as a 0..1 fraction.
          // Carrying the fraction rather than a yes/no is what lets the mesher
          // place the surface partway through a voxel and come out smooth.
          const fill = clamp01((surface - wy) / VOXEL_SIZE);

          if (fill > 0) {
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
            occupancy = Math.round(fill * 255);

            if (g.caves && depth > VOXEL_SIZE * 2) {
              const cave = fbm3(wx / 70, wy / 45, wz / 70, g.seed + 991, 3);
              // Fade the cave edge over a band so its walls are smooth too.
              const carve = clamp01((cave - 0.58) / 0.08);
              occupancy = Math.round(occupancy * (1 - carve));
              if (occupancy === 0) material = AIR;
            }
          }

          if (material === AIR && wy < g.seaLevel * 0.55) {
            material = waterId;
            // Water fills its voxel up to the waterline.
            occupancy = Math.round(clamp01((g.seaLevel * 0.55 - wy) / VOXEL_SIZE) * 255);
            if (occupancy === 0) material = AIR;
          }

          if (material !== AIR) {
            const index = Chunk.index(lx, ly, lz);
            chunk.data[index] = material;
            chunk.occupancy[index] = occupancy;
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
      const solid =
        m !== AIR &&
        !(ignoreWater && m === MATERIAL_ID.Water) &&
        this.getOccupancy(vx, vy, vz) >= VoxelWorld.SOLID_THRESHOLD;
      if (solid) {
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
