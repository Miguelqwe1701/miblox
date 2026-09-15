import * as THREE from "three";
import {
  BasePart,
  DataModel,
  Instance as EngineInstance,
  Lighting,
  materialProps,
} from "@miblox/core";

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

  private onAdded(inst: EngineInstance): void {
    if (!(inst instanceof BasePart)) return;
    if (this.objects.has(inst)) return;
    const mesh = new THREE.Mesh(this.geometryFor(inst), this.materialFor(inst));
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
    (mesh.material as THREE.Material).dispose();
    this.objects.delete(inst);
    this.targets.delete(inst);
  }

  /** Unit geometries, scaled per part, so every box shares one buffer. */
  private geometryFor(part: BasePart): THREE.BufferGeometry {
    const shape = part.Shape ?? "Block";
    let geometry = this.geometries.get(shape);
    if (!geometry) {
      geometry =
        shape === "Ball"
          ? new THREE.SphereGeometry(0.5, 16, 12)
          : shape === "Cylinder"
            ? new THREE.CylinderGeometry(0.5, 0.5, 1, 16)
            : new THREE.BoxGeometry(1, 1, 1);
      this.geometries.set(shape, geometry);
    }
    return geometry;
  }

  private materialFor(part: BasePart): THREE.Material {
    const props = materialProps(part.Material);
    const material = new THREE.MeshLambertMaterial({
      color: new THREE.Color(part.Color.r, part.Color.g, part.Color.b),
      transparent: part.Transparency > 0,
      opacity: 1 - part.Transparency,
    });
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

      const material = mesh.material as THREE.MeshLambertMaterial;
      material.color.setRGB(part.Color.r, part.Color.g, part.Color.b);
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
