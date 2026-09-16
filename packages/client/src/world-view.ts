import * as THREE from "three";
import {
  BasePart,
  DataModel,
  Instance as EngineInstance,
  Lighting,
  MeshPart,
  builtinMeshName,
  isBuiltinMesh,
  materialProps,
} from "@miblox/core";

/**
 * Shapes the renderer can build without downloading anything.
 *
 * Every geometry is unit-sized and centred, so a part's Size scales it the
 * same way a Block does and nothing needs per-shape placement code.
 */
function buildBuiltinMesh(name: string): THREE.BufferGeometry {
  switch (name) {
    case "sphere": return new THREE.SphereGeometry(0.5, 20, 14);
    case "cylinder": return new THREE.CylinderGeometry(0.5, 0.5, 1, 20);
    case "cone": return new THREE.ConeGeometry(0.5, 1, 20);
    case "torus": return new THREE.TorusGeometry(0.35, 0.15, 12, 24).rotateX(Math.PI / 2);
    case "capsule": return new THREE.CapsuleGeometry(0.35, 0.5, 6, 12);
    case "diamond": return new THREE.OctahedronGeometry(0.5, 0);
    case "wedge": {
      // A right-angled prism: half a cube, cut corner to corner.
      const shape = new THREE.Shape();
      shape.moveTo(-0.5, -0.5);
      shape.lineTo(0.5, -0.5);
      shape.lineTo(-0.5, 0.5);
      shape.closePath();
      return new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false }).translate(0, 0, -0.5);
    }
    case "cap": {
      // A peaked cap: a shallow dome with a brim.
      const dome = new THREE.SphereGeometry(0.5, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
      const brim = new THREE.CylinderGeometry(0.62, 0.62, 0.08, 16).translate(0, 0.02, -0.12);
      return mergeGeometries([dome, brim]);
    }
    case "crown": {
      const band = new THREE.CylinderGeometry(0.5, 0.5, 0.35, 16, 1, true);
      const points: THREE.BufferGeometry[] = [band];
      for (let i = 0; i < 6; i++) {
        const angle = (i / 6) * Math.PI * 2;
        points.push(
          new THREE.ConeGeometry(0.12, 0.35, 6).translate(
            Math.cos(angle) * 0.44,
            0.32,
            Math.sin(angle) * 0.44,
          ),
        );
      }
      return mergeGeometries(points);
    }
    default: return new THREE.BoxGeometry(1, 1, 1);
  }
}

/** Concatenates geometries into one, so a composite shape is a single mesh. */
function mergeGeometries(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  for (const part of parts) {
    const geometry = part.index ? part.toNonIndexed() : part;
    const position = geometry.getAttribute("position");
    const normal = geometry.getAttribute("normal");
    const uv = geometry.getAttribute("uv");
    for (let i = 0; i < position.count; i++) {
      positions.push(position.getX(i), position.getY(i), position.getZ(i));
      if (normal) normals.push(normal.getX(i), normal.getY(i), normal.getZ(i));
      if (uv) uvs.push(uv.getX(i), uv.getY(i));
    }
    if (geometry !== part) geometry.dispose();
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  if (normals.length === positions.length) {
    merged.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  } else {
    merged.computeVertexNormals();
  }
  if (uvs.length === (positions.length / 3) * 2) {
    merged.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  }
  return merged;
}

/**
 * Draws the part tree.
 *
 * One three.js object per BasePart, created and destroyed as instances arrive
 * and leave, and synced from the replicated DataModel each frame. Parts are
 * interpolated toward their replicated pose so a 30Hz server still looks
 * smooth at 60fps or more.
 */
export class WorldView {
  readonly group = new THREE.Group();
  private readonly objects = new Map<BasePart, THREE.Mesh>();
  private readonly targets = new Map<BasePart, { position: THREE.Vector3; quaternion: THREE.Quaternion }>();
  private readonly geometries = new Map<string, THREE.BufferGeometry>();
  private readonly textures = new Map<string, THREE.Texture>();
  private readonly meshRequests = new Map<string, Promise<THREE.BufferGeometry>>();
  /** Parts this client simulates itself are not interpolated. */
  isLocallySimulated: (part: BasePart) => boolean = () => false;

  constructor(private readonly game: DataModel) {
    this.group.name = "Parts";
    this.game.InstanceAdded.Connect((inst) => this.onAdded(inst));
    this.game.InstanceRemoved.Connect((inst) => this.onRemoved(inst));
    // Anything already present before this view existed.
    for (const inst of this.game.byId.values()) this.onAdded(inst);
  }

  get partCount(): number {
    return this.objects.size;
  }

  /** A face texture goes on the front of the head only, not all six sides. */
  private isFacePart(part: BasePart): boolean {
    return part.Name === "Head" && !!part.TextureId;
  }

  /**
   * Materials for a head: plain skin everywhere, the face on the front.
   *
   * BoxGeometry takes six materials in +X, -X, +Y, -Y, +Z, -Z order, and a
   * character's front is -Z, so the face is the last of the six.
   */
  private headMaterials(part: BasePart): THREE.Material[] {
    const skin = () =>
      new THREE.MeshLambertMaterial({
        color: new THREE.Color(part.Color.r, part.Color.g, part.Color.b),
        flatShading: true,
      });
    const face = new THREE.MeshLambertMaterial({
      color: new THREE.Color(part.Color.r, part.Color.g, part.Color.b),
      map: this.textureFor(part.TextureId),
      transparent: true,
      flatShading: true,
    });
    return [skin(), skin(), skin(), skin(), skin(), face];
  }

  private onAdded(inst: EngineInstance): void {
    if (!(inst instanceof BasePart)) return;
    if (this.objects.has(inst)) return;
    const mesh = new THREE.Mesh(
      this.geometryFor(inst),
      this.isFacePart(inst) ? this.headMaterials(inst) : this.materialFor(inst),
    );
    mesh.name = inst.Name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.part = inst;
    this.applyTransform(mesh, inst);
    this.objects.set(inst, mesh);
    this.targets.set(inst, {
      position: mesh.position.clone(),
      quaternion: mesh.quaternion.clone(),
    });
    this.group.add(mesh);
  }

  private onRemoved(inst: EngineInstance): void {
    if (!(inst instanceof BasePart)) return;
    const mesh = this.objects.get(inst);
    if (!mesh) return;
    this.group.remove(mesh);
    const material = mesh.material as THREE.Material | THREE.Material[];
    if (Array.isArray(material)) for (const entry of material) entry.dispose();
    else material.dispose();
    this.objects.delete(inst);
    this.targets.delete(inst);
  }

  /** Unit geometries, scaled per part, so every box shares one buffer. */
  private geometryFor(part: BasePart): THREE.BufferGeometry {
    if (part instanceof MeshPart && part.MeshId) {
      if (isBuiltinMesh(part.MeshId)) return this.cachedGeometry(part.MeshId, () =>
        buildBuiltinMesh(builtinMeshName(part.MeshId)),
      );
      // An external mesh is fetched in the background; until it arrives the
      // part is drawn as a box, which is better than nothing appearing at all.
      void this.loadExternalMesh(part);
      return this.cachedGeometry("Block", () => new THREE.BoxGeometry(1, 1, 1));
    }

    const shape = part.Shape ?? "Block";
    return this.cachedGeometry(shape, () =>
      shape === "Ball"
        ? new THREE.SphereGeometry(0.5, 16, 12)
        : shape === "Cylinder"
          ? new THREE.CylinderGeometry(0.5, 0.5, 1, 16)
          : new THREE.BoxGeometry(1, 1, 1),
    );
  }

  private cachedGeometry(key: string, build: () => THREE.BufferGeometry): THREE.BufferGeometry {
    let geometry = this.geometries.get(key);
    if (!geometry) {
      geometry = build();
      this.geometries.set(key, geometry);
    }
    return geometry;
  }

  /**
   * Loads a glTF/GLB mesh and swaps it in when it arrives.
   *
   * The loader is imported on demand: most places use built-in shapes, and
   * pulling it into the main bundle would cost every player who never sees a
   * custom mesh.
   */
  private async loadExternalMesh(part: MeshPart): Promise<void> {
    const url = part.MeshId;
    if (this.meshRequests.has(url)) {
      const geometry = await this.meshRequests.get(url)!;
      this.applyGeometry(part, geometry);
      return;
    }
    const request = (async () => {
      const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
      const gltf = await new GLTFLoader().loadAsync(url);
      const geometries: THREE.BufferGeometry[] = [];
      gltf.scene.updateMatrixWorld(true);
      gltf.scene.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh || !mesh.geometry) return;
        const geometry = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
        geometries.push(geometry.index ? geometry.toNonIndexed() : geometry);
      });
      if (!geometries.length) throw new Error(`${url} contained no meshes`);
      const merged = mergeGeometries(geometries);
      for (const geometry of geometries) geometry.dispose();
      // Normalised into a unit box so Size scales it like every other part.
      merged.computeBoundingBox();
      const box = merged.boundingBox!;
      const size = new THREE.Vector3();
      box.getSize(size);
      const centre = new THREE.Vector3();
      box.getCenter(centre);
      const largest = Math.max(size.x, size.y, size.z) || 1;
      merged.translate(-centre.x, -centre.y, -centre.z).scale(1 / largest, 1 / largest, 1 / largest);
      return merged;
    })();

    this.meshRequests.set(url, request);
    try {
      this.applyGeometry(part, await request);
    } catch (err) {
      console.warn(`[miblox] could not load mesh ${url}:`, err);
      this.meshRequests.delete(url);
    }
  }

  private applyGeometry(part: BasePart, geometry: THREE.BufferGeometry): void {
    const mesh = this.objects.get(part);
    if (mesh) mesh.geometry = geometry;
  }

  /** Textures are shared by URL, so a hundred players in one shirt cost one. */
  private textureFor(url: string): THREE.Texture {
    let texture = this.textures.get(url);
    if (!texture) {
      texture = new THREE.TextureLoader().load(url);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      this.textures.set(url, texture);
    }
    return texture;
  }

  private materialFor(part: BasePart): THREE.Material {
    const props = materialProps(part.Material);
    const material = new THREE.MeshLambertMaterial({
      color: new THREE.Color(part.Color.r, part.Color.g, part.Color.b),
      transparent: part.Transparency > 0,
      opacity: 1 - part.Transparency,
    });
    if (part.TextureId) {
      material.map = this.textureFor(part.TextureId);
      // A textured part keeps its colour as a tint rather than overriding it.
      material.color.set(0xffffff);
    }
    // Neon reads as self-lit; everything else takes scene lighting.
    if (part.Material === "Neon") {
      (material as THREE.MeshLambertMaterial).emissive = new THREE.Color(
        part.Color.r,
        part.Color.g,
        part.Color.b,
      );
    }
    material.flatShading = true;
    void props;
    return material;
  }

  private applyTransform(mesh: THREE.Mesh, part: BasePart): void {
    const cf = part.CFrame;
    mesh.position.set(cf.position.x, cf.position.y, cf.position.z);
    mesh.scale.set(part.Size.x, part.Size.y, part.Size.z);
    const m = new THREE.Matrix4().fromArray(cf.toMatrix4());
    mesh.quaternion.setFromRotationMatrix(m);
  }

  /**
   * Syncs every part. `alpha` is the interpolation factor toward the latest
   * replicated pose; 1 snaps, which is what locally simulated parts want.
   */
  update(dt: number): void {
    const blend = Math.min(dt * 18, 1);
    for (const [part, mesh] of this.objects) {
      const cf = part.CFrame;
      const target = this.targets.get(part)!;
      target.position.set(cf.position.x, cf.position.y, cf.position.z);
      target.quaternion.setFromRotationMatrix(new THREE.Matrix4().fromArray(cf.toMatrix4()));

      if (this.isLocallySimulated(part)) {
        // Already simulated here, so showing anything but the exact pose would
        // add lag to the one thing that must feel immediate.
        mesh.position.copy(target.position);
        mesh.quaternion.copy(target.quaternion);
      } else {
        mesh.position.lerp(target.position, blend);
        mesh.quaternion.slerp(target.quaternion, blend);
      }

      mesh.scale.set(part.Size.x, part.Size.y, part.Size.z);
      mesh.visible = part.Transparency < 1;

      if (Array.isArray(mesh.material)) {
        // A head with a face: keep the skin colour in step and leave the face
        // texture alone.
        for (const entry of mesh.material as THREE.MeshLambertMaterial[]) {
          entry.color.setRGB(part.Color.r, part.Color.g, part.Color.b);
        }
        continue;
      }
      const material = mesh.material as THREE.MeshLambertMaterial;
      const textureId = part.TextureId ?? "";
      const currentTexture = (material.map?.userData.url as string) ?? "";
      if (textureId !== currentTexture) {
        material.map = textureId ? this.textureFor(textureId) : null;
        if (material.map) material.map.userData.url = textureId;
        material.needsUpdate = true;
      }
      if (material.map) material.color.setRGB(1, 1, 1);
      else material.color.setRGB(part.Color.r, part.Color.g, part.Color.b);
      const opacity = 1 - part.Transparency;
      if (material.opacity !== opacity) {
        material.opacity = opacity;
        material.transparent = part.Transparency > 0;
        material.needsUpdate = true;
      }
    }
  }

  /** Snaps everything to its replicated pose, for the first frame after a join. */
  snap(): void {
    for (const [part, mesh] of this.objects) this.applyTransform(mesh, part);
  }

  dispose(): void {
    for (const part of [...this.objects.keys()]) this.onRemoved(part);
    for (const geometry of this.geometries.values()) geometry.dispose();
    this.geometries.clear();
    for (const texture of this.textures.values()) texture.dispose();
    this.textures.clear();
  }
}

/** Sky, sun and fog, driven by the replicated Lighting service. */
export class SkyView {
  readonly sun = new THREE.DirectionalLight(0xffffff, 2);
  readonly ambient = new THREE.HemisphereLight(0xbcd7ff, 0x50504a, 1.1);

  constructor(
    private readonly scene: THREE.Scene,
    private readonly lighting: Lighting,
  ) {
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 600;
    const extent = 180;
    Object.assign(this.sun.shadow.camera, {
      left: -extent,
      right: extent,
      top: extent,
      bottom: -extent,
    });
    // Changing an orthographic frustum does nothing until the projection is
    // rebuilt; without this the shadow map covers a 10-unit box and the rest
    // of the world renders mis-shadowed.
    this.sun.shadow.camera.updateProjectionMatrix();
    this.sun.shadow.bias = -0.0008;
    this.sun.shadow.normalBias = 0.6;
    scene.add(this.sun);
    scene.add(this.sun.target);
    scene.add(this.ambient);
    scene.fog = new THREE.Fog(0xc8d4e0, 200, 1400);
  }

  update(focus: THREE.Vector3): void {
    const dir = this.lighting.getSunDirection();
    this.sun.position.set(focus.x + dir.x * 250, focus.y + dir.y * 250, focus.z + dir.z * 250);
    this.sun.target.position.copy(focus);
    this.sun.target.updateMatrixWorld();
    this.sun.updateMatrixWorld();
    this.sun.shadow.camera.updateMatrixWorld();

    // Night is dim rather than black, so a player is never fully blind.
    const daylight = Math.max(0, Math.min(1, dir.y * 1.4 + 0.25));
    this.sun.intensity = 0.35 + daylight * 1.9;
    this.ambient.intensity = 0.35 + daylight * 0.8;

    const horizon = new THREE.Color(0x0b1024).lerp(new THREE.Color(0x9fc4e8), daylight);
    this.scene.background = horizon;
    if (this.scene.fog instanceof THREE.Fog) {
      this.scene.fog.color.copy(horizon);
      this.scene.fog.near = 250;
      this.scene.fog.far = 1600;
    }
  }
}
