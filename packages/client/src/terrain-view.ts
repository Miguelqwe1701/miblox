import * as THREE from "three";
import {
  CHUNK_SIZE,
  MATERIAL_BY_ID,
  VOXEL_SIZE,
  materialProps,
  type VoxelWorld,
} from "@miblox/core";
import {
  CHUNK,
  FLOATS_PER_VERTEX,
  VERTEX_LAYOUT,
  createMesher,
  newPaddedVolume,
  type Mesher,
} from "@miblox/wasm";

/** Per-material colour lookup, indexed by voxel material id. */
function buildPalette(): THREE.Color[] {
  return MATERIAL_BY_ID.map((name) =>
    new THREE.Color(name === "Air" ? 0x000000 : materialProps(name).color),
  );
}

/**
 * Draws voxel terrain.
 *
 * Chunks are meshed by the WASM greedy mesher and cached; a chunk is remeshed
 * only when its version changes, so an edit costs one chunk and its neighbours
 * rather than the whole world.
 */
export class TerrainView {
  readonly group = new THREE.Group();
  private mesher: Mesher | null = null;
  private readonly palette = buildPalette();
  private readonly padded = newPaddedVolume();
  private readonly meshes = new Map<string, { solid: THREE.Mesh; water: THREE.Mesh | null; version: number }>();
  private readonly solidMaterial: THREE.Material;
  private readonly waterMaterial: THREE.Material;
  /** Chunks meshed so far, for the HUD. */
  stats = { chunks: 0, triangles: 0, backend: "none" };

  constructor(private readonly voxels: VoxelWorld) {
    this.group.name = "Terrain";
    this.solidMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.waterMaterial = new THREE.MeshLambertMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
  }

  async init(wasmUrl?: string): Promise<void> {
    let source: ArrayBuffer | undefined;
    if (wasmUrl) {
      try {
        const res = await fetch(wasmUrl);
        if (res.ok) source = await res.arrayBuffer();
      } catch {
        // Falls through to the JavaScript mesher below.
      }
    }
    this.mesher = await createMesher(source, (err) =>
      console.warn("[miblox] using the JavaScript mesher:", err),
    );
    this.stats.backend = this.mesher.backend;
  }

  /** Rebuilds the mesh for one chunk. Safe to call on an unloaded chunk. */
  updateChunk(cx: number, cy: number, cz: number): void {
    if (!this.mesher) return;
    const key = `${cx},${cy},${cz}`;
    const chunk = this.voxels.getChunk(cx, cy, cz);
    if (!chunk || chunk.isEmpty) {
      this.removeChunk(key);
      return;
    }

    const cached = this.meshes.get(key);
    if (cached && cached.version === chunk.version) return;

    // One voxel of neighbour data on each side, so shared faces are hidden.
    const base = { x: cx * CHUNK_SIZE, y: cy * CHUNK_SIZE, z: cz * CHUNK_SIZE };
    for (let y = -1; y <= CHUNK; y++) {
      for (let z = -1; z <= CHUNK; z++) {
        for (let x = -1; x <= CHUNK; x++) {
          const inside = x >= 0 && x < CHUNK && y >= 0 && y < CHUNK && z >= 0 && z < CHUNK;
          const value = inside
            ? chunk.get(x, y, z)
            : this.voxels.hasChunk(
                  cx + Math.floor((base.x + x) / CHUNK_SIZE) - cx,
                  cy + Math.floor((base.y + y) / CHUNK_SIZE) - cy,
                  cz + Math.floor((base.z + z) / CHUNK_SIZE) - cz,
                )
              ? this.voxels.getVoxel(base.x + x, base.y + y, base.z + z)
              : 0;
          this.padded[(y + 1) * 18 * 18 + (z + 1) * 18 + (x + 1)] = value;
        }
      }
    }

    this.removeChunk(key);
    const origin = new THREE.Vector3(
      base.x * VOXEL_SIZE,
      base.y * VOXEL_SIZE,
      base.z * VOXEL_SIZE,
    );

    const solid = this.buildMesh(this.padded, 1, this.solidMaterial, origin);
    const water = this.buildMesh(this.padded, 0, this.waterMaterial, origin);
    if (!solid && !water) return;

    if (solid) this.group.add(solid);
    if (water) this.group.add(water);
    this.meshes.set(key, {
      solid: solid ?? new THREE.Mesh(),
      water,
      version: chunk.version,
    });
    this.recount();
  }

  private buildMesh(
    padded: Uint8Array,
    pass: number,
    material: THREE.Material,
    origin: THREE.Vector3,
  ): THREE.Mesh | null {
    const result = this.mesher!.meshChunk(padded, pass);
    if (result.vertexCount === 0) return null;

    const positions = new Float32Array(result.vertexCount * 3);
    const normals = new Float32Array(result.vertexCount * 3);
    const colors = new Float32Array(result.vertexCount * 3);

    for (let i = 0; i < result.vertexCount; i++) {
      const o = i * FLOATS_PER_VERTEX;
      // Voxel coordinates are in chunk units; scale to studs.
      positions[i * 3 + 0] = result.vertices[o + 0] * VOXEL_SIZE;
      positions[i * 3 + 1] = result.vertices[o + 1] * VOXEL_SIZE;
      positions[i * 3 + 2] = result.vertices[o + 2] * VOXEL_SIZE;
      normals[i * 3 + 0] = result.vertices[o + VERTEX_LAYOUT.normal.offset + 0];
      normals[i * 3 + 1] = result.vertices[o + VERTEX_LAYOUT.normal.offset + 1];
      normals[i * 3 + 2] = result.vertices[o + VERTEX_LAYOUT.normal.offset + 2];

      const color = this.palette[result.vertices[o + VERTEX_LAYOUT.material.offset]] ?? this.palette[1];
      // Occlusion is folded into vertex colour, which keeps this to one draw
      // call per chunk with no custom shader.
      const shade = result.vertices[o + VERTEX_LAYOUT.occlusion.offset];
      colors[i * 3 + 0] = color.r * shade;
      colors[i * 3 + 1] = color.g * shade;
      colors[i * 3 + 2] = color.b * shade;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geometry.setIndex(new THREE.BufferAttribute(result.indices, 1));
    geometry.computeBoundingSphere();

    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(origin);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    return mesh;
  }

  private removeChunk(key: string): void {
    const existing = this.meshes.get(key);
    if (!existing) return;
    for (const mesh of [existing.solid, existing.water]) {
      if (!mesh) continue;
      this.group.remove(mesh);
      mesh.geometry?.dispose();
    }
    this.meshes.delete(key);
  }

  private recount(): void {
    let triangles = 0;
    for (const entry of this.meshes.values()) {
      for (const mesh of [entry.solid, entry.water]) {
        const index = mesh?.geometry?.getIndex();
        if (index) triangles += index.count / 3;
      }
    }
    this.stats.chunks = this.meshes.size;
    this.stats.triangles = triangles;
  }

  /** Remeshes the chunks named by `keys`, plus their neighbours. */
  refresh(keys: Iterable<string>): void {
    const todo = new Set<string>();
    for (const key of keys) {
      const [x, y, z] = key.split(",").map(Number);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            todo.add(`${x + dx},${y + dy},${z + dz}`);
          }
        }
      }
    }
    for (const key of todo) {
      const [x, y, z] = key.split(",").map(Number);
      if (!this.voxels.hasChunk(x, y, z)) continue;
      this.updateChunk(x, y, z);
    }
  }

  dispose(): void {
    for (const key of [...this.meshes.keys()]) this.removeChunk(key);
    this.solidMaterial.dispose();
    this.waterMaterial.dispose();
  }
}
