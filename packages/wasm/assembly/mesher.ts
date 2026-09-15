/**
 * Greedy voxel mesher with ambient occlusion.
 *
 * This is the hot path of terrain rendering: every chunk that comes into view,
 * and every chunk a player edits, is remeshed. Naively emitting six quads per
 * voxel produces ~150k triangles for one 16^3 chunk of solid ground; merging
 * coplanar faces of the same material brings a typical chunk down to a few
 * hundred, which is the difference between a playable frame rate on a phone
 * and not.
 *
 * IMPORTANT: this file is compiled twice, by `asc` to WebAssembly and by `tsc`
 * to JavaScript, so that a browser which cannot load the .wasm still renders
 * identical geometry. Keep it to the intersection of both languages:
 *   - annotate every integer as i32/u8 (asc needs it; the shim maps it to number)
 *   - use only typed arrays, never plain arrays, objects or closures
 *   - no integer division (asc truncates, JS does not) - multiply instead
 *   - no string operations, exceptions or Math beyond min/max
 * There is a test that meshes the same chunks through both builds and asserts
 * the vertex buffers match byte for byte.
 */

/** Voxels per chunk edge. Must match CHUNK_SIZE in @miblox/core. */
export const CHUNK: i32 = 16;
/** Chunk plus a one-voxel border of neighbour data, so border faces are right. */
export const PAD: i32 = 18;
const PAD2: i32 = PAD * PAD;

/** Floats per vertex: position 3, normal 3, uv 2, material 1, occlusion 1. */
export const FLOATS_PER_VERTEX: i32 = 10;

/**
 * Worst case is a checkerboard, where no two faces can ever merge.
 *
 * Faces sit on slice *boundaries*, and there are CHUNK+1 of those per axis
 * (the chunk's outer faces included), not CHUNK. Sizing this to CHUNK^3*3
 * under-allocates by 768 quads, which WebAssembly traps on and plain
 * JavaScript silently swallows - so the count matters.
 */
const MAX_QUADS: i32 = 3 * CHUNK * CHUNK * (CHUNK + 1);
const MAX_VERTICES: i32 = MAX_QUADS * 4;

/** Padded voxel input. The host writes materials here before meshing. */
export const voxels: Uint8Array = new Uint8Array(PAD * PAD * PAD);
/** Interleaved vertex output. */
export const vertices: Float32Array = new Float32Array(MAX_VERTICES * FLOATS_PER_VERTEX);
/** Triangle indices, two triangles per quad. */
export const indices: Uint32Array = new Uint32Array(MAX_QUADS * 6);

/** Per-slice face mask. Reused across slices to avoid reallocation. */
const mask: Int32Array = new Int32Array(CHUNK * CHUNK);

let vertexCount: i32 = 0;
let indexCount: i32 = 0;
/** Set if the output buffers ran out of room; the host turns this into an error. */
let overflowed: bool = false;

export function getVertexCount(): i32 {
  return vertexCount;
}

export function getIndexCount(): i32 {
  return indexCount;
}

export function getOverflowed(): bool {
  return overflowed;
}

export function getMaxQuads(): i32 {
  return MAX_QUADS;
}

/** Water is meshed as a separate translucent pass, so it never merges with solids. */
export const MATERIAL_WATER: i32 = 5;

function voxelAt(x: i32, y: i32, z: i32): i32 {
  // Coordinates are chunk-local (-1..CHUNK), shifted into the padded volume.
  return <i32>voxels[(y + 1) * PAD2 + (z + 1) * PAD + (x + 1)];
}

/** True when a voxel blocks light for occlusion purposes. */
function occludes(x: i32, y: i32, z: i32): bool {
  const m: i32 = voxelAt(x, y, z);
  return m != 0 && m != MATERIAL_WATER;
}

/**
 * Vertex occlusion from the three voxels touching a face corner, giving the
 * soft darkening in concave corners that makes blocky terrain readable.
 * Returns 0 (darkest) to 3 (fully lit).
 */
function cornerOcclusion(side1: bool, side2: bool, corner: bool): i32 {
  if (side1 && side2) return 0;
  let n: i32 = 3;
  if (side1) n -= 1;
  if (side2) n -= 1;
  if (corner) n -= 1;
  return n;
}

/**
 * Meshes the padded chunk currently in `voxels`.
 *
 * `solidPass` selects which geometry to emit: 1 for opaque materials, 0 for
 * water. Returns the number of quads written.
 */
export function meshChunk(solidPass: i32): i32 {
  vertexCount = 0;
  indexCount = 0;
  overflowed = false;
  let quads: i32 = 0;

  // One sweep per axis; each sweep walks slices perpendicular to that axis.
  for (let d: i32 = 0; d < 3; d++) {
    const u: i32 = (d + 1) % 3;
    const v: i32 = (d + 2) % 3;

    for (let slice: i32 = -1; slice < CHUNK; slice++) {
      // Build the face mask for this slice. A non-zero entry encodes the
      // material, which way the face points, and its four corner occlusions,
      // so that two cells merge only if they would look identical.
      let n: i32 = 0;
      for (let jv: i32 = 0; jv < CHUNK; jv++) {
        for (let ju: i32 = 0; ju < CHUNK; ju++) {
          let ax: i32 = 0;
          let ay: i32 = 0;
          let az: i32 = 0;
          if (d == 0) { ax = slice; ay = ju; az = jv; }
          else if (d == 1) { ax = jv; ay = slice; az = ju; }
          else { ax = ju; ay = jv; az = slice; }

          let bx: i32 = ax;
          let by: i32 = ay;
          let bz: i32 = az;
          if (d == 0) bx += 1;
          else if (d == 1) by += 1;
          else bz += 1;

          const ma: i32 = voxelAt(ax, ay, az);
          const mb: i32 = voxelAt(bx, by, bz);
          const aSolid: bool = solidPass == 1 ? ma != 0 && ma != MATERIAL_WATER : ma == MATERIAL_WATER;
          const bSolid: bool = solidPass == 1 ? mb != 0 && mb != MATERIAL_WATER : mb == MATERIAL_WATER;

          // A face exists only where this pass's material meets something else.
          if (aSolid == bSolid) {
            mask[n] = 0;
            n++;
            continue;
          }

          // The face belongs to whichever side is solid; it points outward.
          const back: i32 = aSolid ? 0 : 1;
          const material: i32 = aSolid ? ma : mb;
          // The air-side voxel is where occlusion is sampled from.
          let ox: i32 = aSolid ? bx : ax;
          let oy: i32 = aSolid ? by : ay;
          let oz: i32 = aSolid ? bz : az;

          const ao: i32 = occlusionCode(ox, oy, oz, u, v);
          mask[n] = material | (back << 8) | (ao << 9);
          n++;
        }
      }

      // Greedily merge the mask into the largest possible rectangles.
      n = 0;
      for (let jv: i32 = 0; jv < CHUNK; jv++) {
        let ju: i32 = 0;
        while (ju < CHUNK) {
          const value: i32 = mask[n];
          if (value == 0) {
            ju++;
            n++;
            continue;
          }

          // Grow along u while the mask matches.
          let w: i32 = 1;
          while (ju + w < CHUNK && mask[n + w] == value) w++;

          // Then grow along v, but only in complete rows.
          let h: i32 = 1;
          let grow: bool = true;
          while (jv + h < CHUNK && grow) {
            const rowStart: i32 = n + h * CHUNK;
            for (let k: i32 = 0; k < w; k++) {
              if (mask[rowStart + k] != value) {
                grow = false;
                break;
              }
            }
            if (grow) h++;
          }

          if (vertexCount + 4 > MAX_VERTICES) {
            // Cannot happen for a 16^3 chunk given MAX_QUADS above, but a
            // silent out-of-bounds write is the worst possible failure here.
            overflowed = true;
            return quads;
          }
          emitQuad(d, u, v, slice, ju, jv, w, h, value);
          quads++;

          // Clear the consumed rectangle so it is not emitted again.
          for (let dv: i32 = 0; dv < h; dv++) {
            const rowStart: i32 = n + dv * CHUNK;
            for (let du: i32 = 0; du < w; du++) mask[rowStart + du] = 0;
          }

          ju += w;
          n += w;
        }
      }
    }
  }
  return quads;
}

/** Packs the four corner occlusion values of one face into eight bits. */
function occlusionCode(ox: i32, oy: i32, oz: i32, u: i32, v: i32): i32 {
  let code: i32 = 0;
  for (let c: i32 = 0; c < 4; c++) {
    // Corner c walks (0,0), (1,0), (0,1), (1,1) in the face plane.
    const su: i32 = (c & 1) == 0 ? -1 : 1;
    const sv: i32 = (c & 2) == 0 ? -1 : 1;

    let u1x: i32 = 0; let u1y: i32 = 0; let u1z: i32 = 0;
    if (u == 0) u1x = su; else if (u == 1) u1y = su; else u1z = su;
    let v1x: i32 = 0; let v1y: i32 = 0; let v1z: i32 = 0;
    if (v == 0) v1x = sv; else if (v == 1) v1y = sv; else v1z = sv;

    const side1: bool = occludes(ox + u1x, oy + u1y, oz + u1z);
    const side2: bool = occludes(ox + v1x, oy + v1y, oz + v1z);
    const corner: bool = occludes(ox + u1x + v1x, oy + u1y + v1y, oz + u1z + v1z);
    code |= cornerOcclusion(side1, side2, corner) << (c * 2);
  }
  return code;
}

function emitQuad(
  d: i32,
  u: i32,
  v: i32,
  slice: i32,
  ju: i32,
  jv: i32,
  w: i32,
  h: i32,
  value: i32,
): void {
  const material: i32 = value & 0xff;
  const back: i32 = (value >> 8) & 1;
  const ao: i32 = (value >> 9) & 0xff;

  // The quad sits on the boundary between slice and slice+1.
  const base: i32 = slice + 1;

  // Corner offsets in the (u, v) plane of the face.
  const c0u: i32 = 0, c0v: i32 = 0;
  const c1u: i32 = w, c1v: i32 = 0;
  const c2u: i32 = 0, c2v: i32 = h;
  const c3u: i32 = w, c3v: i32 = h;

  const nx: f32 = d == 0 ? (back == 1 ? -1.0 : 1.0) : 0.0;
  const ny: f32 = d == 1 ? (back == 1 ? -1.0 : 1.0) : 0.0;
  const nz: f32 = d == 2 ? (back == 1 ? -1.0 : 1.0) : 0.0;

  const first: i32 = vertexCount;
  pushVertex(d, u, v, base, ju + c0u, jv + c0v, nx, ny, nz, 0.0, 0.0, material, ao & 3);
  pushVertex(d, u, v, base, ju + c1u, jv + c1v, nx, ny, nz, <f32>w, 0.0, material, (ao >> 2) & 3);
  pushVertex(d, u, v, base, ju + c2u, jv + c2v, nx, ny, nz, 0.0, <f32>h, material, (ao >> 4) & 3);
  pushVertex(d, u, v, base, ju + c3u, jv + c3v, nx, ny, nz, <f32>w, <f32>h, material, (ao >> 6) & 3);

  // Winding depends on which way the face points, so back faces are not culled.
  if (back == 1) {
    indices[indexCount + 0] = first + 0;
    indices[indexCount + 1] = first + 1;
    indices[indexCount + 2] = first + 3;
    indices[indexCount + 3] = first + 0;
    indices[indexCount + 4] = first + 3;
    indices[indexCount + 5] = first + 2;
  } else {
    indices[indexCount + 0] = first + 0;
    indices[indexCount + 1] = first + 3;
    indices[indexCount + 2] = first + 1;
    indices[indexCount + 3] = first + 0;
    indices[indexCount + 4] = first + 2;
    indices[indexCount + 5] = first + 3;
  }
  indexCount += 6;
}

function pushVertex(
  d: i32,
  u: i32,
  v: i32,
  base: i32,
  pu: i32,
  pv: i32,
  nx: f32,
  ny: f32,
  nz: f32,
  tu: f32,
  tv: f32,
  material: i32,
  occlusion: i32,
): void {
  let x: i32 = 0;
  let y: i32 = 0;
  let z: i32 = 0;
  if (d == 0) x = base; else if (d == 1) y = base; else z = base;
  if (u == 0) x = pu; else if (u == 1) y = pu; else z = pu;
  if (v == 0) x = pv; else if (v == 1) y = pv; else z = pv;

  const o: i32 = vertexCount * FLOATS_PER_VERTEX;
  vertices[o + 0] = <f32>x;
  vertices[o + 1] = <f32>y;
  vertices[o + 2] = <f32>z;
  vertices[o + 3] = nx;
  vertices[o + 4] = ny;
  vertices[o + 5] = nz;
  vertices[o + 6] = tu;
  vertices[o + 7] = tv;
  vertices[o + 8] = <f32>material;
  // Handed to the shader as a 0..1 light multiplier.
  vertices[o + 9] = <f32>occlusion * 0.25 + 0.25;
  vertexCount++;
}

/** Clears the padded voxel buffer between chunks. */
export function clearVoxels(): void {
  for (let i: i32 = 0; i < PAD * PAD * PAD; i++) voxels[i] = 0;
}
