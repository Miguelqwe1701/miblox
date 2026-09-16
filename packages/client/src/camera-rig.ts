import * as THREE from "three";
import { BasePart, PhysicsWorld, Vector3 } from "@miblox/core";
import type { InputState } from "./controls.js";

export type CameraMode = "ThirdPerson" | "FirstPerson";

export type Vec3 = [number, number, number];

/**
 * One scripted camera move.
 *
 * Roblox calls this a Scriptable camera; the idea is the same. A shot says
 * where the camera starts and ends and how long it takes, and the director
 * eases between the two. Nothing here touches player input, so a cutscene can
 * run over a character the player is still driving.
 */
export interface CameraShot {
  /** Seconds the move takes. */
  duration: number;
  /** Camera position, at the start and the end of the shot. */
  eye: [Vec3, Vec3];
  /** What the camera looks at, at the start and the end. */
  target: [Vec3, Vec3];
  /**
   * Track a part: `eye` and `target` become offsets from it rather than
   * fixed world points, so the shot stays framed on a moving character.
   */
  follow?: BasePart | null;
  /** Swing around the target instead of sliding in a straight line. */
  orbit?: boolean;
  /** Field of view at the start and the end, for a push-in or pull-back. */
  fov?: [number, number];
  ease?: "linear" | "inOut" | "out";
}

const EASINGS: Record<string, (t: number) => number> = {
  linear: (t) => t,
  inOut: (t) => t * t * (3 - 2 * t),
  out: (t) => 1 - (1 - t) ** 3,
};

const vec = (v: Vec3) => new THREE.Vector3(v[0], v[1], v[2]);

/**
 * Plays a list of shots, one after another.
 *
 * Kept apart from the follow camera so the two never fight: while a sequence
 * is playing the rig hands the camera over wholesale, and takes it back when
 * the last shot ends.
 */
export class CinematicDirector {
  private queue: CameraShot[] = [];
  private elapsed = 0;
  private onDone: (() => void) | null = null;

  get active(): boolean {
    return this.queue.length > 0;
  }

  /** Starts a sequence, replacing anything already playing. */
  play(shots: CameraShot[]): Promise<void> {
    this.queue = shots.slice();
    this.elapsed = 0;
    return new Promise((resolve) => {
      this.onDone = resolve;
    });
  }

  stop(): void {
    this.queue = [];
    this.elapsed = 0;
    const done = this.onDone;
    this.onDone = null;
    done?.();
  }

  /** Advances the sequence and points the camera. Returns false when idle. */
  update(camera: THREE.PerspectiveCamera, dt: number): boolean {
    const shot = this.queue[0];
    if (!shot) return false;
    this.elapsed += dt;

    const raw = shot.duration > 0 ? Math.min(this.elapsed / shot.duration, 1) : 1;
    const t = (EASINGS[shot.ease ?? "inOut"] ?? EASINGS.inOut)(raw);

    // A followed part turns the shot's points into offsets from wherever it
    // is right now, so the framing holds as the subject moves.
    const anchor = shot.follow
      ? new THREE.Vector3(
          shot.follow.CFrame.position.x,
          shot.follow.CFrame.position.y,
          shot.follow.CFrame.position.z,
        )
      : new THREE.Vector3();

    const target = vec(shot.target[0]).lerp(vec(shot.target[1]), t).add(anchor);
    let eye: THREE.Vector3;
    if (shot.orbit) {
      // Interpolating the angle rather than the position keeps the camera at
      // a constant distance, so an orbit sweeps round instead of cutting
      // across the middle of the subject.
      const a = vec(shot.eye[0]).add(anchor).sub(target);
      const b = vec(shot.eye[1]).add(anchor).sub(target);
      const angleA = Math.atan2(a.x, a.z);
      let sweep = Math.atan2(b.x, b.z) - angleA;
      while (sweep > Math.PI) sweep -= Math.PI * 2;
      while (sweep < -Math.PI) sweep += Math.PI * 2;
      const angle = angleA + sweep * t;
      const radiusA = Math.hypot(a.x, a.z);
      const radius = radiusA + (Math.hypot(b.x, b.z) - radiusA) * t;
      eye = new THREE.Vector3(
        target.x + Math.sin(angle) * radius,
        target.y + a.y + (b.y - a.y) * t,
        target.z + Math.cos(angle) * radius,
      );
    } else {
      eye = vec(shot.eye[0]).lerp(vec(shot.eye[1]), t).add(anchor);
    }

    camera.position.copy(eye);
    camera.lookAt(target);
    if (shot.fov) {
      const fov = shot.fov[0] + (shot.fov[1] - shot.fov[0]) * t;
      if (camera.fov !== fov) {
        camera.fov = fov;
        camera.updateProjectionMatrix();
      }
    }

    if (raw >= 1) {
      this.queue.shift();
      this.elapsed = 0;
      if (this.queue.length === 0) {
        const done = this.onDone;
        this.onDone = null;
        done?.();
      }
    }
    return true;
  }
}

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
  /** Scripted camera moves. While one is playing it owns the camera. */
  readonly cinematic = new CinematicDirector();

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
    // A scripted shot takes the camera over completely, but the player keeps
    // control of their character: the trailer walks while the camera swoops.
    if (this.cinematic.update(this.camera, dt)) return;
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
