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

// ---------------------------------------------------------------------------
// Smooth terrain (Surface Nets)
// ---------------------------------------------------------------------------

/**
 * Per-voxel fill, 0..255, parallel to `voxels`.
 *
 * The blocky mesher only asks whether a voxel has a material. The smooth one
 * contours this scalar field instead, so a half-full voxel puts the surface
 * halfway through it and hills come out rounded rather than stepped.
 */
export const occupancy: Uint8Array = new Uint8Array(PAD * PAD * PAD);

/**
 * Density at which the surface sits.
 *
 * Everything below computes in f64 and narrows to f32 only when writing a
 * vertex. AssemblyScript would otherwise do this arithmetic in f32 while the
 * JavaScript build does it in f64, and the two would drift apart - which the
 * backend-parity test catches.
 */
const ISO: f64 = 0.5;

/** Cells span sample pairs, so there is one more per axis than there are voxels. */
const CELLS: i32 = CHUNK + 1;
const CELLS2: i32 = CELLS * CELLS;

/** Vertex index emitted for each cell, or -1 where the cell has no surface. */
const cellVertex: Int32Array = new Int32Array(CELLS * CELLS * CELLS);

/**
 * Lookup tables and scratch buffers.
 *
 * All module level and filled once: AssemblyScript is built here with the stub
 * runtime, which never frees, so allocating inside the meshing loops would grow
 * linear memory without bound. Plain typed arrays also keep this file portable
 * to the plain-TypeScript build, which has no StaticArray.
 */
const CORNER_X: Int32Array = new Int32Array(8);
const CORNER_Y: Int32Array = new Int32Array(8);
const CORNER_Z: Int32Array = new Int32Array(8);
const EDGE_A: Int32Array = new Int32Array(12);
const EDGE_B: Int32Array = new Int32Array(12);
/** Corner densities of the cell being processed. */
const cellDensity: Float64Array = new Float64Array(8);
/** Vertex indices of the four cells around one edge. */
const quadCorners: Int32Array = new Int32Array(4);
let tablesReady: bool = false;

function initTables(): void {
  if (tablesReady) return;
  for (let i: i32 = 0; i < 8; i++) {
    CORNER_X[i] = i & 1;
    CORNER_Y[i] = (i >> 1) & 1;
    CORNER_Z[i] = (i >> 2) & 1;
  }
  // Four edges along each axis, as pairs of corner indices.
  const a: i32[] = [0, 2, 4, 6, 0, 1, 4, 5, 0, 1, 2, 3];
  const b: i32[] = [1, 3, 5, 7, 2, 3, 6, 7, 4, 5, 6, 7];
  for (let i: i32 = 0; i < 12; i++) {
    EDGE_A[i] = a[i];
    EDGE_B[i] = b[i];
  }
  tablesReady = true;
}

/** Density of the sample at chunk-local voxel coordinates, for one pass. */
function densityAt(x: i32, y: i32, z: i32, solidPass: i32): f64 {
  if (x < -1 || y < -1 || z < -1 || x > CHUNK || y > CHUNK || z > CHUNK) return 0.0;
  const index: i32 = (y + 1) * PAD2 + (z + 1) * PAD + (x + 1);
  const material: i32 = <i32>voxels[index];
  if (material == 0) return 0.0;
  const inPass: bool =
    solidPass == 1 ? material != MATERIAL_WATER : material == MATERIAL_WATER;
  if (!inPass) return 0.0;
  return <f64>(<i32>occupancy[index]) / 255.0;
}

/** Keeps an occlusion probe inside the padded volume. */
function clampCell(v: i32): i32 {
  if (v < -1) return -1;
  if (v > CHUNK) return CHUNK;
  return v;
}

function materialAt(x: i32, y: i32, z: i32): i32 {
  if (x < -1 || y < -1 || z < -1 || x > CHUNK || y > CHUNK || z > CHUNK) return 0;
  return <i32>voxels[(y + 1) * PAD2 + (z + 1) * PAD + (x + 1)];
}

/**
 * Meshes the padded chunk as a smooth surface.
 *
 * Naive Surface Nets: every cell whose eight corners are not all on the same
 * side of the isosurface contributes one vertex, placed at the average of the
 * crossings along its edges; quads then join the four cells around each
 * sign-changing edge. One vertex per cell keeps the output small and the
 * result watertight, which marching cubes only manages with more cases.
 */
export function meshChunkSmooth(solidPass: i32): i32 {
  vertexCount = 0;
  indexCount = 0;
  overflowed = false;

  initTables();
  for (let i: i32 = 0; i < CELLS * CELLS * CELLS; i++) cellVertex[i] = -1;

  const d: Float64Array = cellDensity;

  // Pass one: place a vertex in every cell the surface passes through.
  for (let cz: i32 = -1; cz < CHUNK; cz++) {
    for (let cy: i32 = -1; cy < CHUNK; cy++) {
      for (let cx: i32 = -1; cx < CHUNK; cx++) {
        let inside: i32 = 0;
        for (let c: i32 = 0; c < 8; c++) {
          const value: f64 = densityAt(cx + CORNER_X[c], cy + CORNER_Y[c], cz + CORNER_Z[c], solidPass);
          d[c] = value;
          if (value >= ISO) inside |= 1 << c;
        }
        // Entirely inside or entirely outside means no surface here.
        if (inside == 0 || inside == 255) continue;

        let sx: f64 = 0.0;
        let sy: f64 = 0.0;
        let sz: f64 = 0.0;
        let crossings: i32 = 0;

        for (let e: i32 = 0; e < 12; e++) {
          const a: i32 = EDGE_A[e];
          const b: i32 = EDGE_B[e];
          const da: f64 = d[a];
          const db: f64 = d[b];
          const aIn: bool = da >= ISO;
          const bIn: bool = db >= ISO;
          if (aIn == bIn) continue;
          const span: f64 = db - da;
          // Guarded: two corners can straddle the iso with an equal value.
          const t: f64 = span == 0.0 ? 0.5 : (ISO - da) / span;
          sx += <f64>CORNER_X[a] + t * <f64>(CORNER_X[b] - CORNER_X[a]);
          sy += <f64>CORNER_Y[a] + t * <f64>(CORNER_Y[b] - CORNER_Y[a]);
          sz += <f64>CORNER_Z[a] + t * <f64>(CORNER_Z[b] - CORNER_Z[a]);
          crossings++;
        }
        if (crossings == 0) continue;

        const inv: f64 = 1.0 / <f64>crossings;
        if (vertexCount + 1 > MAX_VERTICES) {
          overflowed = true;
          return 0;
        }

        // Samples sit at voxel centres, so the cell origin is offset by half.
        const px: f64 = <f64>cx + 0.5 + sx * inv;
        const py: f64 = <f64>cy + 0.5 + sy * inv;
        const pz: f64 = <f64>cz + 0.5 + sz * inv;

        // The gradient of the density field is the surface normal.
        let nx: f64 = densityAt(cx - 1, cy, cz, solidPass) - densityAt(cx + 2, cy, cz, solidPass);
        let ny: f64 = densityAt(cx, cy - 1, cz, solidPass) - densityAt(cx, cy + 2, cz, solidPass);
        let nz: f64 = densityAt(cx, cy, cz - 1, solidPass) - densityAt(cx, cy, cz + 2, solidPass);
        const length: f64 = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (length > 0.00001) {
          nx /= length;
          ny /= length;
          nz /= length;
        } else {
          ny = 1.0;
        }

        // Material comes from the fullest corner that is actually in this pass.
        let material: i32 = 0;
        let best: f64 = -1.0;
        for (let c: i32 = 0; c < 8; c++) {
          if (d[c] <= best) continue;
          const m: i32 = materialAt(cx + CORNER_X[c], cy + CORNER_Y[c], cz + CORNER_Z[c]);
          if (m == 0) continue;
          best = d[c];
          material = m;
        }

        // Crevices are darker: sample the field just outside the surface and
        // darken by how much material is still in the way.
        // Clamped into the padded volume rather than allowed to fall outside:
        // outside reads as empty, which would make every chunk border brighter
        // than its neighbour and draw a visible seam across flat ground.
        const ax: i32 = clampCell(<i32>Math.round(px + nx * 1.5));
        const ay: i32 = clampCell(<i32>Math.round(py + ny * 1.5));
        const az: i32 = clampCell(<i32>Math.round(pz + nz * 1.5));
        const blocked: f64 = densityAt(ax, ay, az, solidPass);
        const shade: f64 = 1.0 - blocked * 0.45;

        const o: i32 = vertexCount * FLOATS_PER_VERTEX;
        vertices[o + 0] = <f32>px;
        vertices[o + 1] = <f32>py;
        vertices[o + 2] = <f32>pz;
        vertices[o + 3] = <f32>nx;
        vertices[o + 4] = <f32>ny;
        vertices[o + 5] = <f32>nz;
        // Triplanar-friendly uv: world position works for any orientation.
        vertices[o + 6] = <f32>px;
        vertices[o + 7] = <f32>pz;
        vertices[o + 8] = <f32>material;
        vertices[o + 9] = <f32>shade;

        cellVertex[(cz + 1) * CELLS2 + (cy + 1) * CELLS + (cx + 1)] = vertexCount;
        vertexCount++;
      }
    }
  }

  // Pass two: join the four cells around each sign-changing edge into a quad.
  let quads: i32 = 0;
  for (let cz: i32 = -1; cz < CHUNK; cz++) {
    for (let cy: i32 = -1; cy < CHUNK; cy++) {
      for (let cx: i32 = -1; cx < CHUNK; cx++) {
        const here: f64 = densityAt(cx, cy, cz, solidPass);
        const hereIn: bool = here >= ISO;

        for (let axis: i32 = 0; axis < 3; axis++) {
          const nxv: i32 = axis == 0 ? cx + 1 : cx;
          const nyv: i32 = axis == 1 ? cy + 1 : cy;
          const nzv: i32 = axis == 2 ? cz + 1 : cz;
          const there: f64 = densityAt(nxv, nyv, nzv, solidPass);
          if ((there >= ISO) == hereIn) continue;

          // The two axes perpendicular to this edge.
          const u: i32 = (axis + 1) % 3;
          const v: i32 = (axis + 2) % 3;

          let ok: bool = true;
          const corner: Int32Array = quadCorners;
          for (let q: i32 = 0; q < 4; q++) {
            const du: i32 = (q & 1) == 0 ? 0 : -1;
            const dv: i32 = (q & 2) == 0 ? 0 : -1;
            let ox: i32 = cx;
            let oy: i32 = cy;
            let oz: i32 = cz;
            if (u == 0) ox += du; else if (u == 1) oy += du; else oz += du;
            if (v == 0) ox += dv; else if (v == 1) oy += dv; else oz += dv;
            if (ox < -1 || oy < -1 || oz < -1 || ox >= CHUNK || oy >= CHUNK || oz >= CHUNK) {
              ok = false;
              break;
            }
            const index: i32 = cellVertex[(oz + 1) * CELLS2 + (oy + 1) * CELLS + (ox + 1)];
            if (index < 0) {
              ok = false;
              break;
            }
            corner[q] = index;
          }
          if (!ok) continue;
          if (indexCount + 6 > MAX_QUADS * 6) {
            overflowed = true;
            return quads;
          }

          // Quad order 0,1,3,2 walks the ring; flip it when the edge runs from
          // solid to empty so every face points out of the terrain.
          if (hereIn) {
            indices[indexCount + 0] = corner[0];
            indices[indexCount + 1] = corner[1];
            indices[indexCount + 2] = corner[3];
            indices[indexCount + 3] = corner[0];
            indices[indexCount + 4] = corner[3];
            indices[indexCount + 5] = corner[2];
          } else {
            indices[indexCount + 0] = corner[0];
            indices[indexCount + 1] = corner[3];
            indices[indexCount + 2] = corner[1];
            indices[indexCount + 3] = corner[0];
            indices[indexCount + 4] = corner[2];
            indices[indexCount + 5] = corner[3];
          }
          indexCount += 6;
          quads++;
        }
      }
    }
  }
  return quads;
}

export function clearOccupancy(): void {
  for (let i: i32 = 0; i < PAD * PAD * PAD; i++) occupancy[i] = 0;
}
