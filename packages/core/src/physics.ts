import { CFrame, Vector3, clamp } from "./math.js";
import { BasePart, Humanoid, Model, Workspace } from "./classes.js";
import type { Instance } from "./instance.js";
import {
  AIR,
  MATERIAL_ID,
  VOXEL_SIZE,
  VoxelWorld,
  worldToVoxel,
} from "./terrain-data.js";
import { materialProps } from "./enums.js";

export interface AABB {
  min: Vector3;
  max: Vector3;
}

export function aabbOverlap(a: AABB, b: AABB): boolean {
  return (
    a.min.x < b.max.x &&
    a.max.x > b.min.x &&
    a.min.y < b.max.y &&
    a.max.y > b.min.y &&
    a.min.z < b.max.z &&
    a.max.z > b.min.z
  );
}

export interface RaycastResult {
  position: Vector3;
  normal: Vector3;
  distance: number;
  instance: BasePart | null;
  material: string;
}

export interface RaycastParams {
  filterDescendantsInstances?: Instance[];
  /** "Exclude" skips the filter list, "Include" restricts to it. */
  filterType?: "Exclude" | "Include";
  ignoreWater?: boolean;
  maxDistance?: number;
}

/** Slab-method ray/AABB test. Returns entry distance, or null when missed. */
export function rayAABB(
  origin: Vector3,
  dir: Vector3,
  box: AABB,
): { t: number; normal: Vector3 } | null {
  let tmin = -Infinity;
  let tmax = Infinity;
  let normalAxis = 0;
  let normalSign = 1;

  const o = [origin.x, origin.y, origin.z];
  const d = [dir.x, dir.y, dir.z];
  const bmin = [box.min.x, box.min.y, box.min.z];
  const bmax = [box.max.x, box.max.y, box.max.z];

  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-9) {
      if (o[a] < bmin[a] || o[a] > bmax[a]) return null;
      continue;
    }
    const inv = 1 / d[a];
    let t1 = (bmin[a] - o[a]) * inv;
    let t2 = (bmax[a] - o[a]) * inv;
    let sign = -1;
    if (t1 > t2) {
      [t1, t2] = [t2, t1];
      sign = 1;
    }
    if (t1 > tmin) {
      tmin = t1;
      normalAxis = a;
      normalSign = sign;
    }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  if (tmax < 0) return null;
  const t = tmin < 0 ? 0 : tmin;
  const n = [0, 0, 0];
  n[normalAxis] = normalSign;
  return { t, normal: new Vector3(n[0], n[1], n[2]) };
}

/**
 * Rigid-body and character simulation. Deliberately simple and deterministic:
 * fixed timestep, axis-separated resolution, no rotation on dynamic bodies.
 * That is enough for a blocky sandbox and keeps server and client in step.
 */
export class PhysicsWorld {
  /** Fixed simulation step; the server accumulates real time into these. */
  readonly stepTime = 1 / 60;
  gravity = 196.2;

  constructor(
    private readonly workspace: Workspace,
    private readonly voxels: VoxelWorld,
  ) {}

  private collectParts(): BasePart[] {
    const out: BasePart[] = [];
    const stack: Instance[] = [...this.workspace.childrenRef];
    while (stack.length) {
      const inst = stack.pop()!;
      if (inst instanceof BasePart) out.push(inst);
      for (const child of inst.childrenRef) stack.push(child);
    }
    return out;
  }

  step(dt: number): void {
    this.gravity = this.workspace.Gravity;
    const parts = this.collectParts();
    const dynamic = parts.filter((part) => !part.Anchored && !this.isCharacterPart(part));
    const colliders = parts.filter((part) => part.CanCollide);

    for (const part of dynamic) {
      this.stepBody(part, colliders, dt);
    }
    this.stepCharacters(colliders, dt);
    this.cullFallenParts(parts);
  }

  private isCharacterPart(part: BasePart): boolean {
    const model = part.FindFirstAncestorOfClass("Model");
    return !!model && !!model.FindFirstChildOfClass("Humanoid");
  }

  private stepBody(part: BasePart, colliders: BasePart[], dt: number): void {
    let velocity = part.AssemblyLinearVelocity.add(new Vector3(0, -this.gravity * dt, 0));
    let position = part.CFrame.position;
    const half = part.Size.mul(0.5);

    // Axis-separated sweep: move one axis, resolve, then the next. Avoids
    // tunnelling through corners without needing a full CCD pass.
    for (const axis of ["x", "y", "z"] as const) {
      const delta = new Vector3(
        axis === "x" ? velocity.x * dt : 0,
        axis === "y" ? velocity.y * dt : 0,
        axis === "z" ? velocity.z * dt : 0,
      );
      if (delta.magnitude === 0) continue;
      position = position.add(delta);
      const box: AABB = { min: position.sub(half), max: position.add(half) };
      const push = this.resolveBox(box, part, colliders, axis);
      if (push !== 0) {
        position = position.add(
          new Vector3(axis === "x" ? push : 0, axis === "y" ? push : 0, axis === "z" ? push : 0),
        );
        const bounce = -part.elasticity;
        velocity = new Vector3(
          axis === "x" ? velocity.x * bounce : velocity.x,
          axis === "y" ? velocity.y * bounce : velocity.y,
          axis === "z" ? velocity.z * bounce : velocity.z,
        );
        if (axis === "y" && Math.abs(velocity.y) < 4) {
          // Settle instead of jittering on tiny bounces.
          velocity = new Vector3(velocity.x * 0.7, 0, velocity.z * 0.7);
        }
      }
    }

    part.setProperty("CFrame", part.CFrame.add(position.sub(part.CFrame.position)));
    part.setProperty("AssemblyLinearVelocity", velocity);
  }

  /**
   * Returns the smallest displacement along `axis` that pushes `box` out of
   * everything it overlaps, or 0 when it is already clear.
   */
  private resolveBox(
    box: AABB,
    self: BasePart | null,
    colliders: BasePart[],
    axis: "x" | "y" | "z",
  ): number {
    let push = 0;
    const apply = (other: AABB) => {
      const shifted: AABB = {
        min: new Vector3(
          box.min.x + (axis === "x" ? push : 0),
          box.min.y + (axis === "y" ? push : 0),
          box.min.z + (axis === "z" ? push : 0),
        ),
        max: new Vector3(
          box.max.x + (axis === "x" ? push : 0),
          box.max.y + (axis === "y" ? push : 0),
          box.max.z + (axis === "z" ? push : 0),
        ),
      };
      if (!aabbOverlap(shifted, other)) return;
      const up = other.max[axis] - shifted.min[axis];
      const down = shifted.max[axis] - other.min[axis];
      push += up < down ? up : -down;
    };

    for (const other of colliders) {
      if (other === self) continue;
      if (self && other.IsDescendantOf(self)) continue;
      apply(other.getBoundingBox());
    }
    for (const voxelBox of this.voxelBoxesOverlapping(box)) apply(voxelBox);
    return push;
  }

  /** Solid voxel cells whose AABBs intersect `box`. Water is not solid. */
  private voxelBoxesOverlapping(box: AABB): AABB[] {
    const out: AABB[] = [];
    const [x0, y0, z0] = worldToVoxel(box.min);
    const [x1, y1, z1] = worldToVoxel(box.max);
    // Guard against a runaway loop if a part is scaled absurdly.
    if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > 20000) return out;
    for (let y = y0; y <= y1; y++)
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++) {
          const m = this.voxels.getVoxel(x, y, z);
          if (m === AIR || m === MATERIAL_ID.Water) continue;
          const min = new Vector3(x * VOXEL_SIZE, y * VOXEL_SIZE, z * VOXEL_SIZE);
          out.push({ min, max: min.add(new Vector3(VOXEL_SIZE, VOXEL_SIZE, VOXEL_SIZE)) });
        }
    return out;
  }

  private stepCharacters(colliders: BasePart[], dt: number): void {
    for (const child of this.workspace.childrenRef) {
      if (!(child instanceof Model)) continue;
      const humanoid = child.FindFirstChildOfClass("Humanoid") as Humanoid | null;
      const root = child.FindFirstChild("HumanoidRootPart") as BasePart | null;
      if (!humanoid || !root) continue;
      this.stepCharacter(child, humanoid, root, colliders, dt);
    }
  }

  stepCharacter(
    model: Model,
    humanoid: Humanoid,
    root: BasePart,
    colliders: BasePart[],
    dt: number,
  ): void {
    if (humanoid.Health <= 0) {
      humanoid.changeState("Dead");
      return;
    }
    const half = root.Size.mul(0.5);
    let position = root.CFrame.position;
    let velocity = root.AssemblyLinearVelocity;

    const grounded = this.isGrounded(position, half, root, colliders);
    const inWater = this.isInWater(position);

    // Horizontal control: snap toward the requested direction. Air control is
    // reduced so a jump commits, as players expect from a blocky platformer.
    const wish = humanoid.MoveDirection.mul(humanoid.WalkSpeed);
    const control = grounded ? 1 : 0.25;
    const vx = velocity.x + (wish.x - velocity.x) * clamp(control * dt * 18, 0, 1);
    const vz = velocity.z + (wish.z - velocity.z) * clamp(control * dt * 18, 0, 1);
    let vy = velocity.y;

    if (inWater) {
      vy += (-this.gravity * 0.25) * dt;
      vy = clamp(vy, -24, 40);
      if (humanoid.Jump) vy = 24;
      humanoid.changeState("Swimming");
    } else {
      vy -= this.gravity * dt;
      if (grounded) {
        if (vy < 0) vy = 0;
        if (humanoid.Jump) {
          vy = humanoid.JumpPower;
          humanoid.changeState("Jumping");
        } else {
          humanoid.changeState("Running");
        }
      } else {
        humanoid.changeState(vy > 0 ? "Jumping" : "Freefall");
      }
    }
    humanoid.Jump = false;
    velocity = new Vector3(vx, vy, vz);

    for (const axis of ["x", "y", "z"] as const) {
      const d = axis === "x" ? velocity.x * dt : axis === "y" ? velocity.y * dt : velocity.z * dt;
      if (d === 0) continue;
      position = position.add(
        new Vector3(axis === "x" ? d : 0, axis === "y" ? d : 0, axis === "z" ? d : 0),
      );
      const box: AABB = { min: position.sub(half), max: position.add(half) };
      let push = this.resolveBox(box, root, colliders, axis);
      if (push !== 0 && axis !== "y" && grounded) {
        // Step-up: try lifting over obstacles up to one voxel tall.
        const lifted: AABB = {
          min: box.min.add(new Vector3(0, VOXEL_SIZE, 0)),
          max: box.max.add(new Vector3(0, VOXEL_SIZE, 0)),
        };
        if (this.resolveBox(lifted, root, colliders, axis) === 0) {
          position = position.add(new Vector3(0, VOXEL_SIZE, 0));
          push = 0;
        }
      }
      if (push !== 0) {
        position = position.add(
          new Vector3(axis === "x" ? push : 0, axis === "y" ? push : 0, axis === "z" ? push : 0),
        );
        velocity = new Vector3(
          axis === "x" ? 0 : velocity.x,
          axis === "y" ? 0 : velocity.y,
          axis === "z" ? 0 : velocity.z,
        );
      }
    }

    // Face the movement direction, as Roblox's AutoRotate does.
    let cf = new CFrame(
      position,
      root.CFrame.r00, root.CFrame.r01, root.CFrame.r02,
      root.CFrame.r10, root.CFrame.r11, root.CFrame.r12,
      root.CFrame.r20, root.CFrame.r21, root.CFrame.r22,
    );
    const flatMove = new Vector3(humanoid.MoveDirection.x, 0, humanoid.MoveDirection.z);
    if (humanoid.AutoRotate && flatMove.magnitude > 0.01) {
      const target = CFrame.lookAt(position, position.sub(flatMove.unit));
      cf = cf.lerp(target, clamp(dt * 12, 0, 1));
    }

    const delta = cf.position.sub(root.CFrame.position);
    root.setProperty("CFrame", cf);
    root.setProperty("AssemblyLinearVelocity", velocity);
    // Rig parts ride along with the root.
    for (const desc of model.GetDescendants()) {
      if (desc === root || !(desc instanceof BasePart)) continue;
      desc.setProperty("CFrame", desc.CFrame.add(delta));
    }
  }

  isGrounded(position: Vector3, half: Vector3, self: BasePart, colliders: BasePart[]): boolean {
    const probe: AABB = {
      min: position.sub(half).sub(new Vector3(0, 0.35, 0)),
      max: new Vector3(position.x + half.x, position.y - half.y + 0.05, position.z + half.z),
    };
    for (const other of colliders) {
      if (other === self || !other.CanCollide) continue;
      if (self && other.IsDescendantOf(self)) continue;
      if (other.FindFirstAncestorOfClass("Model") === self.FindFirstAncestorOfClass("Model"))
        continue;
      if (aabbOverlap(probe, other.getBoundingBox())) return true;
    }
    return this.voxelBoxesOverlapping(probe).length > 0;
  }

  isInWater(position: Vector3): boolean {
    const [vx, vy, vz] = worldToVoxel(position);
    return this.voxels.getVoxel(vx, vy, vz) === MATERIAL_ID.Water;
  }

  private cullFallenParts(parts: BasePart[]): void {
    const floor = this.workspace.FallenPartsDestroyHeight;
    for (const part of parts) {
      if (part.Anchored) continue;
      if (part.CFrame.position.y < floor) part.Destroy();
    }
  }

  /** Casts against parts and terrain, returning the nearer hit. */
  raycast(origin: Vector3, direction: Vector3, params: RaycastParams = {}): RaycastResult | null {
    const maxDistance = params.maxDistance ?? direction.magnitude ?? 1000;
    const dir = direction.unit;
    const filter = new Set(params.filterDescendantsInstances ?? []);
    const filterType = params.filterType ?? "Exclude";

    let best: RaycastResult | null = null;
    for (const part of this.collectParts()) {
      if (!part.CanQuery) continue;
      const filtered = [...filter].some((f) => part === f || part.IsDescendantOf(f));
      if (filterType === "Exclude" ? filtered : !filtered) continue;
      const hit = rayAABB(origin, dir, part.getBoundingBox());
      if (!hit || hit.t > maxDistance) continue;
      if (!best || hit.t < best.distance) {
        best = {
          position: origin.add(dir.mul(hit.t)),
          normal: hit.normal,
          distance: hit.t,
          instance: part,
          material: part.Material,
        };
      }
    }

    const voxelHit = this.voxels.raycast(origin, dir, maxDistance, params.ignoreWater ?? true);
    if (voxelHit) {
      const distance = voxelHit.position.sub(origin).magnitude;
      if (!best || distance < best.distance) {
        best = {
          position: voxelHit.position,
          normal: voxelHit.normal,
          distance,
          instance: null,
          material: MATERIAL_ID_TO_NAME[voxelHit.material] ?? "Rock",
        };
      }
    }
    return best;
  }
}

const MATERIAL_ID_TO_NAME: Record<number, string> = Object.fromEntries(
  Object.entries(MATERIAL_ID).map(([name, id]) => [id, name]),
);

export { materialProps };
