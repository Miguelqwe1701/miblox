import * as THREE from "three";
import { BasePart, PhysicsWorld, Vector3 } from "@miblox/core";
import type { InputState } from "./controls.js";

export type CameraMode = "ThirdPerson" | "FirstPerson";

/**
 * Follows the local character.
 *
 * The camera pulls in when something is between it and the player, which is the
 * one thing a third-person camera has to get right or the view is regularly
 * lost inside terrain.
 */
export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  mode: CameraMode = "ThirdPerson";
  distance = 22;
  minDistance = 6;
  maxDistance = 60;
  yaw = 0;
  /** View pitch in radians; negative looks slightly down, over the shoulder. */
  pitch = -0.25;
  /** Smoothed focus point, so the view does not jitter with the character. */
  private focus = new THREE.Vector3(0, 20, 0);

  constructor(
    aspect: number,
    private readonly physics: PhysicsWorld,
  ) {
    this.camera = new THREE.PerspectiveCamera(70, aspect, 0.3, 4000);
    this.camera.position.set(0, 40, 60);
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  update(input: InputState, root: BasePart | null, dt: number): void {
    this.yaw = input.lookYaw;
    this.pitch = input.lookPitch;
    if (input.zoom) {
      this.distance = THREE.MathUtils.clamp(
        this.distance + input.zoom,
        this.minDistance,
        this.maxDistance,
      );
      // Zooming all the way in is how Roblox enters first person.
      this.mode = this.distance <= this.minDistance + 0.5 ? "FirstPerson" : "ThirdPerson";
    }

    const target = root
      ? new THREE.Vector3(root.CFrame.position.x, root.CFrame.position.y + 2.5, root.CFrame.position.z)
      : this.focus;
    this.focus.lerp(target, Math.min(dt * 12, 1));

    // Offset from the focus point to the camera. `pitch` is the *view* angle,
    // positive meaning looking up, so the camera sits on the opposite side:
    // looking up lowers it, looking down raises it.
    const direction = new THREE.Vector3(
      Math.sin(this.yaw) * Math.cos(this.pitch),
      -Math.sin(this.pitch),
      Math.cos(this.yaw) * Math.cos(this.pitch),
    );

    if (this.mode === "FirstPerson") {
      const view = new THREE.Vector3(
        -Math.sin(this.yaw) * Math.cos(this.pitch),
        Math.sin(this.pitch),
        -Math.cos(this.yaw) * Math.cos(this.pitch),
      );
      this.camera.position.copy(this.focus);
      this.camera.lookAt(this.focus.clone().add(view.multiplyScalar(10)));
      return;
    }

    let distance = this.distance;
    // Pull in if the line of sight is blocked, so the view never ends up inside
    // a wall or under the ground.
    const origin = new Vector3(this.focus.x, this.focus.y, this.focus.z);
    const back = new Vector3(direction.x, direction.y, direction.z);
    const hit = this.physics.raycast(origin, back, {
      maxDistance: distance,
      filterDescendantsInstances: root ? [root.Parent ?? root] : [],
      filterType: "Exclude",
    });
    // A hit at ~0 means the focus point itself is inside geometry (standing in
    // a cave, say). Collapsing onto the player there would be worse than
    // clipping, so ignore it and keep the requested distance.
    if (hit && hit.distance > 1) {
      distance = Math.max(this.minDistance * 0.5, hit.distance - 1.5);
    }

    this.camera.position
      .copy(this.focus)
      .add(direction.clone().multiplyScalar(distance));
    this.camera.lookAt(this.focus);
  }

  /** Movement basis on the ground plane, so W always means "away from camera". */
  movementBasis(): { forward: THREE.Vector3; right: THREE.Vector3 } {
    const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)).normalize();
    const right = new THREE.Vector3(forward.z, 0, -forward.x).normalize();
    return { forward, right };
  }
}
