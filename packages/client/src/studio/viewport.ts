import * as THREE from "three";
import {
  BasePart,
  CFrame,
  DataModel,
  Instance as EngineInstance,
  MATERIAL_ID,
  Model,
  PhysicsWorld,
  Vector3,
  type Lighting,
} from "@miblox/core";
import { TerrainView } from "../terrain-view.js";
import { SkyView, WorldView } from "../world-view.js";

export type Tool = "select" | "move" | "terrain-add" | "terrain-remove" | "terrain-paint";

export interface ViewportEvents {
  onSelect(instance: EngineInstance | null): void;
  onEdited(): void;
}

/**
 * The Studio 3D view.
 *
 * An orbit camera over the place being edited, click to select, drag to move
 * on the ground plane, and a terrain brush. It reuses the game's renderers so
 * what you build is drawn exactly as players will see it.
 */
export class Viewport {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private terrainView: TerrainView | null = null;
  private worldView: WorldView | null = null;
  private skyView: SkyView | null = null;
  private physics: PhysicsWorld;
  private highlight: THREE.LineSegments;
  private brushRing: THREE.Mesh;

  tool: Tool = "select";
  brushRadius = 12;
  brushMaterial = MATERIAL_ID.Grass;
  selection: EngineInstance | null = null;
  /** Grid size parts snap to while dragging. */
  snap = 1;

  // Orbit state.
  private target = new THREE.Vector3(0, 16, 0);
  private distance = 90;
  private yaw = 0.6;
  private pitch = 0.55;
  private dragging: "orbit" | "pan" | "move" | null = null;
  private lastPointer = new THREE.Vector2();
  private movePlane = new THREE.Plane();
  private moveOffset = new THREE.Vector3();
  private painting = false;

  /** Follows the test character while a test is running. */
  follow: (() => Vector3 | null) | null = null;

  constructor(
    private readonly canvasHost: HTMLElement,
    private game: DataModel,
    private readonly events: ViewportEvents,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    canvasHost.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(65, 1, 0.3, 5000);
    this.physics = new PhysicsWorld(game.Workspace, game.Terrain.voxels);

    // A wireframe box around the selection, rather than a filled overlay that
    // would hide the thing being edited.
    const box = new THREE.BoxGeometry(1, 1, 1);
    this.highlight = new THREE.LineSegments(
      new THREE.EdgesGeometry(box),
      new THREE.LineBasicMaterial({ color: 0x5aa9ff, depthTest: false, transparent: true }),
    );
    this.highlight.renderOrder = 999;
    this.highlight.visible = false;
    this.scene.add(this.highlight);

    this.brushRing = new THREE.Mesh(
      new THREE.RingGeometry(0.95, 1, 48),
      new THREE.MeshBasicMaterial({
        color: 0x8fd3ff,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.8,
        depthTest: false,
      }),
    );
    this.brushRing.renderOrder = 998;
    this.brushRing.visible = false;
    this.scene.add(this.brushRing);

    this.bindPointer();
    window.addEventListener("resize", () => this.resize());
  }

  async init(wasmUrl: string): Promise<void> {
    this.terrainView = new TerrainView(this.game.Terrain.voxels);
    await this.terrainView.init(wasmUrl);
    this.scene.add(this.terrainView.group);

    this.worldView = new WorldView(this.game);
    this.scene.add(this.worldView.group);

    this.skyView = new SkyView(this.scene, this.game.Lighting as Lighting);
    this.rebuildTerrain();
    this.resize();
  }

  /**
   * Swaps the world being displayed, for entering and leaving a test.
   *
   * The renderers hold direct references to instances, so they are rebuilt
   * rather than repointed; anything else would leave the old world's parts on
   * screen alongside the new one's.
   */
  async setGame(game: DataModel, wasmUrl: string): Promise<void> {
    if (this.terrainView) {
      this.scene.remove(this.terrainView.group);
      this.terrainView.dispose();
    }
    if (this.worldView) {
      this.scene.remove(this.worldView.group);
      this.worldView.dispose();
    }
    this.game = game;
    this.physics = new PhysicsWorld(game.Workspace, game.Terrain.voxels);
    this.selection = null;
    this.highlight.visible = false;
    await this.init(wasmUrl);
  }

  /** Meshes every loaded chunk. Studio holds the whole place in memory. */
  rebuildTerrain(): void {
    this.terrainView?.rebuildAll();
  }

  refreshTerrainAround(position: Vector3): void {
    const keys: string[] = [];
    const cx = Math.floor(position.x / 64);
    const cy = Math.floor(position.y / 64);
    const cz = Math.floor(position.z / 64);
    for (let y = cy - 1; y <= cy + 1; y++) {
      for (let z = cz - 1; z <= cz + 1; z++) {
        for (let x = cx - 1; x <= cx + 1; x++) keys.push(`${x},${y},${z}`);
      }
    }
    this.terrainView?.refresh(keys);
  }

  get terrainStats() {
    return this.terrainView?.stats ?? { chunks: 0, triangles: 0, backend: "-" };
  }

  select(instance: EngineInstance | null): void {
    this.selection = instance;
    this.updateHighlight();
  }

  private updateHighlight(): void {
    const part = this.selection;
    if (!(part instanceof BasePart)) {
      this.highlight.visible = false;
      return;
    }
    this.highlight.visible = true;
    this.highlight.position.set(part.CFrame.position.x, part.CFrame.position.y, part.CFrame.position.z);
    this.highlight.scale.set(part.Size.x + 0.05, part.Size.y + 0.05, part.Size.z + 0.05);
    this.highlight.quaternion.setFromRotationMatrix(
      new THREE.Matrix4().fromArray(part.CFrame.toMatrix4()),
    );
  }

  /**
   * Frames the camera on an instance.
   *
   * Models are framed by their bounding box, which is what you want for a
   * character: focusing on its root part alone leaves it a speck in the
   * distance.
   */
  focusOn(instance: EngineInstance): void {
    if (instance instanceof BasePart) {
      const p = instance.CFrame.position;
      this.target.set(p.x, p.y, p.z);
      this.distance = Math.max(12, instance.Size.magnitude * 2.5);
      return;
    }
    if (instance instanceof Model) {
      const box = instance.GetBoundingBox();
      if (box.size.magnitude === 0) return;
      this.target.set(box.center.x, box.center.y, box.center.z);
      this.distance = Math.max(12, box.size.magnitude * 1.8);
      return;
    }
    // A container: frame everything inside it.
    const parts = instance.GetDescendants().filter((d): d is BasePart => d instanceof BasePart);
    if (!parts.length) return;
    let min = parts[0].CFrame.position;
    let max = min;
    for (const part of parts) {
      const bounds = part.getBoundingBox();
      min = new Vector3(
        Math.min(min.x, bounds.min.x),
        Math.min(min.y, bounds.min.y),
        Math.min(min.z, bounds.min.z),
      );
      max = new Vector3(
        Math.max(max.x, bounds.max.x),
        Math.max(max.y, bounds.max.y),
        Math.max(max.z, bounds.max.z),
      );
    }
    const centre = min.add(max).mul(0.5);
    this.target.set(centre.x, centre.y, centre.z);
    this.distance = Math.max(12, max.sub(min).magnitude * 1.6);
  }

  // -- input ---------------------------------------------------------------

  private bindPointer(): void {
    const canvas = this.renderer.domElement;
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    canvas.addEventListener("pointerdown", (event) => {
      canvas.setPointerCapture(event.pointerId);
      this.lastPointer.set(event.clientX, event.clientY);

      if (event.button === 2 || event.shiftKey) {
        this.dragging = event.shiftKey ? "pan" : "orbit";
        return;
      }
      if (event.button === 1) {
        this.dragging = "pan";
        return;
      }
      if (this.tool.startsWith("terrain")) {
        this.painting = true;
        this.paintAt(event);
        return;
      }
      this.pickAt(event);
      if (this.tool === "move" && this.selection instanceof BasePart) {
        this.beginMove(event);
      }
    });

    canvas.addEventListener("pointermove", (event) => {
      const dx = event.clientX - this.lastPointer.x;
      const dy = event.clientY - this.lastPointer.y;
      this.lastPointer.set(event.clientX, event.clientY);

      if (this.painting) {
        this.paintAt(event);
        return;
      }
      if (this.dragging === "orbit") {
        this.yaw -= dx * 0.005;
        this.pitch = THREE.MathUtils.clamp(this.pitch - dy * 0.005, -1.45, 1.45);
        return;
      }
      if (this.dragging === "pan") {
        // Pan in the camera's own plane, scaled by distance so it feels the
        // same however far out you are.
        const right = new THREE.Vector3();
        const up = new THREE.Vector3();
        this.camera.matrixWorld.extractBasis(right, up, new THREE.Vector3());
        const scale = this.distance * 0.0016;
        this.target.addScaledVector(right, -dx * scale);
        this.target.addScaledVector(up, dy * scale);
        return;
      }
      if (this.dragging === "move") {
        this.continueMove(event);
        return;
      }
      if (this.tool.startsWith("terrain")) this.updateBrushRing(event);
    });

    const end = (event: PointerEvent) => {
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      if (this.painting || this.dragging === "move") this.events.onEdited();
      this.painting = false;
      this.dragging = null;
    };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);

    canvas.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        if (this.tool.startsWith("terrain") && event.shiftKey) {
          this.brushRadius = THREE.MathUtils.clamp(
            this.brushRadius - Math.sign(event.deltaY) * 2,
            4,
            48,
          );
          return;
        }
        this.distance = THREE.MathUtils.clamp(
          this.distance * (event.deltaY > 0 ? 1.12 : 0.89),
          6,
          1200,
        );
      },
      { passive: false },
    );
  }

  /** Normalised device coordinates for a pointer event. */
  private ndc(event: PointerEvent): THREE.Vector2 {
    const rect = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
  }

  private ray(event: PointerEvent): { origin: Vector3; direction: Vector3 } {
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(this.ndc(event), this.camera);
    return {
      origin: new Vector3(raycaster.ray.origin.x, raycaster.ray.origin.y, raycaster.ray.origin.z),
      direction: new Vector3(
        raycaster.ray.direction.x,
        raycaster.ray.direction.y,
        raycaster.ray.direction.z,
      ),
    };
  }

  private pickAt(event: PointerEvent): void {
    const { origin, direction } = this.ray(event);
    const hit = this.physics.raycast(origin, direction, { maxDistance: 4000 });
    // Selecting a part selects the model it belongs to, as Studio does, unless
    // the model is already selected: then it drills down to the part.
    let picked: EngineInstance | null = hit?.instance ?? null;
    if (picked) {
      const model = picked.FindFirstAncestorOfClass("Model");
      if (model && this.selection !== model && !picked.IsDescendantOf(this.selection ?? picked)) {
        picked = model;
      }
    }
    this.select(picked);
    this.events.onSelect(picked);
  }

  private beginMove(event: PointerEvent): void {
    const part = this.selection as BasePart;
    const position = new THREE.Vector3(
      part.CFrame.position.x,
      part.CFrame.position.y,
      part.CFrame.position.z,
    );
    // Drag on a horizontal plane through the part, which is what you want for
    // laying things out; vertical moves go through the properties panel.
    this.movePlane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 1, 0), position);

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(this.ndc(event), this.camera);
    const point = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(this.movePlane, point)) return;
    this.moveOffset.copy(position).sub(point);
    this.dragging = "move";
  }

  private continueMove(event: PointerEvent): void {
    const part = this.selection;
    if (!(part instanceof BasePart)) return;
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(this.ndc(event), this.camera);
    const point = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(this.movePlane, point)) return;
    point.add(this.moveOffset);

    const snapped = new Vector3(
      this.snap > 0 ? Math.round(point.x / this.snap) * this.snap : point.x,
      part.CFrame.position.y,
      this.snap > 0 ? Math.round(point.z / this.snap) * this.snap : point.z,
    );
    const delta = snapped.sub(part.CFrame.position);
    // Moving a part inside a selected model moves the whole model.
    const target = this.selection instanceof BasePart ? part : part;
    target.setProperty("CFrame", target.CFrame.add(delta));
    this.updateHighlight();
  }

  private paintAt(event: PointerEvent): void {
    const { origin, direction } = this.ray(event);
    const hit = this.game.Terrain.voxels.raycast(origin, direction, 4000);
    if (!hit) return;

    const terrain = this.game.Terrain;
    if (this.tool === "terrain-remove") {
      terrain.FillBall(hit.position, this.brushRadius, 0);
    } else if (this.tool === "terrain-add") {
      // Offset along the face normal so adding builds outward rather than
      // burying the brush inside the surface it was aimed at.
      const centre = hit.position.add(hit.normal.mul(this.brushRadius * 0.4));
      terrain.FillBall(centre, this.brushRadius, this.brushMaterial);
    } else {
      terrain.FillBall(hit.position, this.brushRadius, this.brushMaterial);
    }
    this.refreshTerrainAround(hit.position);
  }

  private updateBrushRing(event: PointerEvent): void {
    const { origin, direction } = this.ray(event);
    const hit = this.game.Terrain.voxels.raycast(origin, direction, 4000);
    if (!hit) {
      this.brushRing.visible = false;
      return;
    }
    this.brushRing.visible = true;
    this.brushRing.position.set(hit.position.x, hit.position.y, hit.position.z);
    this.brushRing.scale.setScalar(this.brushRadius);
    this.brushRing.lookAt(
      hit.position.x + hit.normal.x,
      hit.position.y + hit.normal.y,
      hit.position.z + hit.normal.z,
    );
  }

  // -- frame ---------------------------------------------------------------

  resize(): void {
    const rect = this.canvasHost.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  render(): void {
    // While testing, the camera tracks the character rather than staying put.
    const followTarget = this.follow?.();
    if (followTarget) {
      this.target.lerp(
        new THREE.Vector3(followTarget.x, followTarget.y + 2, followTarget.z),
        0.2,
      );
    }
    const offset = new THREE.Vector3(
      Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      Math.cos(this.yaw) * Math.cos(this.pitch),
    ).multiplyScalar(this.distance);
    this.camera.position.copy(this.target).add(offset);
    this.camera.lookAt(this.target);

    this.worldView?.update(1 / 60);
    this.updateHighlight();
    this.skyView?.update(this.target);
    this.brushRing.visible = this.brushRing.visible && this.tool.startsWith("terrain");
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.terrainView?.dispose();
    this.worldView?.dispose();
    this.renderer.dispose();
  }
}

export { CFrame };
