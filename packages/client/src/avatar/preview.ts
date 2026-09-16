import * as THREE from "three";
import {
  BasePart,
  DataModel,
  PhysicsWorld,
  Vector3,
  applyDescriptionTo,
  applyPose,
  buildAvatar,
  poseFor,
  type HumanoidDescriptionData,
  type Model,
} from "@miblox/core";
import { WorldView } from "../world-view.js";

/**
 * A turntable view of one character.
 *
 * Reuses the game's renderer rather than drawing avatars a second way, so what
 * the editor shows is exactly what other players will see in a world.
 */
export class AvatarPreview {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly game = new DataModel();
  private readonly worldView: WorldView;
  private character: Model;
  private angle = 0.6;
  /** Elapsed time, so the idle animation reads as breathing rather than a loop. */
  private clock = 0;
  private dragging = false;
  private lastX = 0;
  /** Paused while the tab is hidden, so a background tab costs nothing. */
  private spinning = true;

  constructor(private readonly host: HTMLElement, description: HumanoidDescriptionData) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);
    this.game.Terrain.voxels.generateOnAccess = false;
    void new PhysicsWorld(this.game.Workspace, this.game.Terrain.voxels);

    this.worldView = new WorldView(this.game);
    this.scene.add(this.worldView.group);

    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(6, 12, 9);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    Object.assign(key.shadow.camera, { left: -12, right: 12, top: 14, bottom: -6, near: 1, far: 60 });
    key.shadow.camera.updateProjectionMatrix();
    this.scene.add(key);
    this.scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x2a3040, 1.4));

    // A plinth, so the character is standing on something and casts a shadow.
    const plinth = new THREE.Mesh(
      new THREE.CylinderGeometry(4.2, 4.2, 0.5, 40),
      new THREE.MeshLambertMaterial({ color: 0x232c3c }),
    );
    plinth.position.y = -3.3;
    plinth.receiveShadow = true;
    this.scene.add(plinth);

    this.character = buildAvatar(description, { position: new Vector3(0, 0, 0) });
    this.character.Parent = this.game.Workspace;

    this.bindDrag();
    window.addEventListener("resize", () => this.resize());
    document.addEventListener("visibilitychange", () => {
      this.spinning = !document.hidden;
    });
    this.resize();
    this.loop();
  }

  /** Rebuilds the character's look without recreating the preview. */
  update(description: HumanoidDescriptionData): void {
    applyDescriptionTo(this.character, description);
  }

  private bindDrag(): void {
    const canvas = this.renderer.domElement;
    canvas.style.cursor = "grab";
    canvas.addEventListener("pointerdown", (event) => {
      this.dragging = true;
      this.lastX = event.clientX;
      canvas.style.cursor = "grabbing";
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener("pointermove", (event) => {
      if (!this.dragging) return;
      this.angle -= (event.clientX - this.lastX) * 0.01;
      this.lastX = event.clientX;
    });
    const end = (event: PointerEvent) => {
      this.dragging = false;
      canvas.style.cursor = "grab";
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
  }

  private resize(): void {
    const rect = this.host.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private loop(): void {
    const tick = (): void => {
      // Turning slowly on its own reads as a display; dragging takes over.
      if (this.spinning && !this.dragging) this.angle += 0.004;
      // The same idle animation the game plays, so the editor is not showing a
      // stiffer character than the one you get in a world.
      this.clock += 1 / 60;
      const root = this.character.FindFirstChild("HumanoidRootPart") as BasePart | null;
      if (root) applyPose(this.character, root, poseFor("Running", 0, 16, 0, this.clock));
      const radius = 13;
      this.camera.position.set(
        Math.sin(this.angle) * radius,
        2.2,
        Math.cos(this.angle) * radius,
      );
      this.camera.lookAt(0, -0.4, 0);
      this.worldView.update(1 / 60);
      this.renderer.render(this.scene, this.camera);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}
