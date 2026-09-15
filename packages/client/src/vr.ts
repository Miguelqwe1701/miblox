import * as THREE from "three";
import type { Controls } from "./controls.js";

/**
 * WebXR support.
 *
 * The same client covers headsets in the browser and on desktop: three.js
 * renders both eyes, and the controller thumbstick feeds the ordinary input
 * layer, so movement, building and everything else behaves identically.
 */
export class VRSupport {
  readonly controllers: THREE.XRTargetRaySpace[] = [];
  private gripSpaces: THREE.XRGripSpace[] = [];
  available = false;
  active = false;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly controls: Controls,
    private readonly scene: THREE.Scene,
  ) {}

  /** Sets up XR and reports whether a headset is present. */
  async init(): Promise<boolean> {
    const xr = (navigator as Navigator & { xr?: XRSystem }).xr;
    if (!xr) return false;
    try {
      this.available = await xr.isSessionSupported("immersive-vr");
    } catch {
      this.available = false;
    }
    if (!this.available) return false;

    this.renderer.xr.enabled = true;
    // Roblox-style studs are metres here; 1 unit per stud would make a player
    // 5 metres tall, so the XR reference space is scaled instead.
    this.renderer.xr.setReferenceSpaceType("local-floor");

    for (let i = 0; i < 2; i++) {
      const controller = this.renderer.xr.getController(i);
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(0, 0, 0),
          new THREE.Vector3(0, 0, -1),
        ]),
        new THREE.LineBasicMaterial({ color: 0x8fd3ff }),
      );
      line.scale.z = 40;
      controller.add(line);
      this.scene.add(controller);
      this.controllers.push(controller);

      const grip = this.renderer.xr.getControllerGrip(i);
      const marker = new THREE.Mesh(
        new THREE.BoxGeometry(0.06, 0.06, 0.16),
        new THREE.MeshBasicMaterial({ color: 0x334455 }),
      );
      grip.add(marker);
      this.scene.add(grip);
      this.gripSpaces.push(grip);
    }

    this.renderer.xr.addEventListener("sessionstart", () => {
      this.active = true;
      this.controls.platform = "VR";
    });
    this.renderer.xr.addEventListener("sessionend", () => {
      this.active = false;
      this.controls.platform = "Desktop";
      this.controls.vrMove.set(0, 0);
    });
    return true;
  }

  /** Enters VR. Must be called from a user gesture. */
  async enter(): Promise<void> {
    const xr = (navigator as Navigator & { xr?: XRSystem }).xr;
    if (!xr) throw new Error("This browser does not support WebXR");
    const session = await xr.requestSession("immersive-vr", {
      optionalFeatures: ["local-floor", "bounded-floor", "hand-tracking"],
    });
    await this.renderer.xr.setSession(session);
  }

  /** Reads controller input into the shared input state. */
  update(): void {
    if (!this.active) return;
    const session = this.renderer.xr.getSession();
    if (!session) return;

    this.controls.vrMove.set(0, 0);
    for (const source of session.inputSources) {
      const pad = source.gamepad;
      if (!pad) continue;
      const dead = (v: number) => (Math.abs(v) < 0.2 ? 0 : v);
      if (source.handedness === "left") {
        // Left stick walks, as it does in nearly every VR game.
        this.controls.vrMove.x += dead(pad.axes[2] ?? pad.axes[0] ?? 0);
        this.controls.vrMove.y += dead(pad.axes[3] ?? pad.axes[1] ?? 0);
      } else {
        // Right stick snap-turns, which is far more comfortable than smooth yaw.
        const turn = dead(pad.axes[2] ?? pad.axes[0] ?? 0);
        if (Math.abs(turn) > 0.7 && !this.turnHeld) {
          this.controls.state.lookYaw -= Math.sign(turn) * (Math.PI / 6);
          this.turnHeld = true;
        } else if (Math.abs(turn) < 0.3) {
          this.turnHeld = false;
        }
        if (pad.buttons[0]?.pressed) this.controls.state.primary = true;
        else this.controls.state.primary = false;
        if (pad.buttons[1]?.pressed) this.controls.state.secondary = true;
      }
      if (source.handedness === "left" && pad.buttons[4]?.pressed) this.controls.vrJump = true;
    }
  }

  private turnHeld = false;

  /** In VR the headset provides the view, so the rig only positions the player. */
  positionRig(rig: THREE.Group, position: THREE.Vector3): void {
    if (!this.active) return;
    rig.position.set(position.x, position.y - 2.5, position.z);
  }
}
