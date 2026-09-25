/**
 * Core value types. These are immutable, structurally simple, and shared by the
 * server simulation, the renderer and the Luau VM, so they stay dependency-free.
 */

export class Vector3 {
  static readonly zero = new Vector3(0, 0, 0);
  static readonly one = new Vector3(1, 1, 1);
  static readonly xAxis = new Vector3(1, 0, 0);
  static readonly yAxis = new Vector3(0, 1, 0);
  static readonly zAxis = new Vector3(0, 0, 1);

  constructor(readonly x = 0, readonly y = 0, readonly z = 0) {}

  add(v: Vector3): Vector3 {
    return new Vector3(this.x + v.x, this.y + v.y, this.z + v.z);
  }
  sub(v: Vector3): Vector3 {
    return new Vector3(this.x - v.x, this.y - v.y, this.z - v.z);
  }
  mul(s: number | Vector3): Vector3 {
    return typeof s === "number"
      ? new Vector3(this.x * s, this.y * s, this.z * s)
      : new Vector3(this.x * s.x, this.y * s.y, this.z * s.z);
  }
  div(s: number | Vector3): Vector3 {
    return typeof s === "number"
      ? new Vector3(this.x / s, this.y / s, this.z / s)
      : new Vector3(this.x / s.x, this.y / s.y, this.z / s.z);
  }
  neg(): Vector3 {
    return new Vector3(-this.x, -this.y, -this.z);
  }
  dot(v: Vector3): number {
    return this.x * v.x + this.y * v.y + this.z * v.z;
  }
  cross(v: Vector3): Vector3 {
    return new Vector3(
      this.y * v.z - this.z * v.y,
      this.z * v.x - this.x * v.z,
      this.x * v.y - this.y * v.x,
    );
  }
  get magnitude(): number {
    return Math.sqrt(this.dot(this));
  }
  get unit(): Vector3 {
    const m = this.magnitude;
    return m === 0 ? Vector3.zero : this.div(m);
  }
  lerp(v: Vector3, a: number): Vector3 {
    return new Vector3(
      this.x + (v.x - this.x) * a,
      this.y + (v.y - this.y) * a,
      this.z + (v.z - this.z) * a,
    );
  }
  abs(): Vector3 {
    return new Vector3(Math.abs(this.x), Math.abs(this.y), Math.abs(this.z));
  }
  floor(): Vector3 {
    return new Vector3(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z));
  }
  equals(v: Vector3, eps = 1e-6): boolean {
    return (
      Math.abs(this.x - v.x) < eps &&
      Math.abs(this.y - v.y) < eps &&
      Math.abs(this.z - v.z) < eps
    );
  }
  toString(): string {
    return `${this.x}, ${this.y}, ${this.z}`;
  }
  toArray(): [number, number, number] {
    return [this.x, this.y, this.z];
  }
  static fromArray(a: readonly number[]): Vector3 {
    return new Vector3(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0);
  }
}

export class Vector2 {
  static readonly zero = new Vector2(0, 0);
  constructor(readonly x = 0, readonly y = 0) {}
  add(v: Vector2): Vector2 {
    return new Vector2(this.x + v.x, this.y + v.y);
  }
  sub(v: Vector2): Vector2 {
    return new Vector2(this.x - v.x, this.y - v.y);
  }
  mul(s: number): Vector2 {
    return new Vector2(this.x * s, this.y * s);
  }
  get magnitude(): number {
    return Math.hypot(this.x, this.y);
  }
  get unit(): Vector2 {
    const m = this.magnitude;
    return m === 0 ? Vector2.zero : new Vector2(this.x / m, this.y / m);
  }
  toString(): string {
    return `${this.x}, ${this.y}`;
  }
}

/** One axis of a GUI measurement: a fraction of the parent plus pixels. */
export class UDim {
  constructor(readonly scale = 0, readonly offset = 0) {}
  add(o: UDim): UDim {
    return new UDim(this.scale + o.scale, this.offset + o.offset);
  }
  sub(o: UDim): UDim {
    return new UDim(this.scale - o.scale, this.offset - o.offset);
  }
  /** Resolves against a parent length in pixels. */
  resolve(parentPixels: number): number {
    return this.scale * parentPixels + this.offset;
  }
  toString(): string {
    return `${this.scale}, ${this.offset}`;
  }
}

/**
 * A GUI position or size. Scale is relative to the parent, so a HUD laid out
 * in scale fits a phone and a monitor alike; offset is in pixels.
 */
export class UDim2 {
  static readonly zero = new UDim2(new UDim(), new UDim());
  constructor(readonly x: UDim = new UDim(), readonly y: UDim = new UDim()) {}
  static new(xScale: number, xOffset: number, yScale: number, yOffset: number): UDim2 {
    return new UDim2(new UDim(xScale, xOffset), new UDim(yScale, yOffset));
  }
  static fromScale(x: number, y: number): UDim2 {
    return UDim2.new(x, 0, y, 0);
  }
  static fromOffset(x: number, y: number): UDim2 {
    return UDim2.new(0, x, 0, y);
  }
  add(o: UDim2): UDim2 {
    return new UDim2(this.x.add(o.x), this.y.add(o.y));
  }
  sub(o: UDim2): UDim2 {
    return new UDim2(this.x.sub(o.x), this.y.sub(o.y));
  }
  lerp(o: UDim2, a: number): UDim2 {
    const l = (p: number, q: number) => p + (q - p) * a;
    return UDim2.new(
      l(this.x.scale, o.x.scale),
      l(this.x.offset, o.x.offset),
      l(this.y.scale, o.y.scale),
      l(this.y.offset, o.y.offset),
    );
  }
  toArray(): [number, number, number, number] {
    return [this.x.scale, this.x.offset, this.y.scale, this.y.offset];
  }
  static fromArray(a: readonly number[]): UDim2 {
    return UDim2.new(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, a[3] ?? 0);
  }
  toString(): string {
    return `{${this.x}}, {${this.y}}`;
  }
}

export class Color3 {
  constructor(readonly r = 0, readonly g = 0, readonly b = 0) {}
  static fromRGB(r: number, g: number, b: number): Color3 {
    return new Color3(r / 255, g / 255, b / 255);
  }
  static fromHex(hex: number): Color3 {
    return Color3.fromRGB((hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff);
  }
  toHex(): number {
    const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
    return (c(this.r) << 16) | (c(this.g) << 8) | c(this.b);
  }
  lerp(o: Color3, a: number): Color3 {
    return new Color3(
      this.r + (o.r - this.r) * a,
      this.g + (o.g - this.g) * a,
      this.b + (o.b - this.b) * a,
    );
  }
  toString(): string {
    return `${this.r}, ${this.g}, ${this.b}`;
  }
}

/**
 * A rigid transform: 3x3 rotation (row-major, stored as basis vectors) plus a
 * position. Mirrors Roblox's CFrame closely enough that scripts port over.
 */
export class CFrame {
  static readonly identity = new CFrame(Vector3.zero, 1, 0, 0, 0, 1, 0, 0, 0, 1);

  /** Rotation matrix components, row-major: r{row}{col}. */
  constructor(
    readonly position: Vector3 = Vector3.zero,
    readonly r00 = 1,
    readonly r01 = 0,
    readonly r02 = 0,
    readonly r10 = 0,
    readonly r11 = 1,
    readonly r12 = 0,
    readonly r20 = 0,
    readonly r21 = 0,
    readonly r22 = 1,
  ) {}

  static fromPosition(p: Vector3): CFrame {
    return new CFrame(p);
  }

  /** Right / up / back basis vectors, matching Roblox's column convention. */
  get rightVector(): Vector3 {
    return new Vector3(this.r00, this.r10, this.r20);
  }
  get upVector(): Vector3 {
    return new Vector3(this.r01, this.r11, this.r21);
  }
  get backVector(): Vector3 {
    return new Vector3(this.r02, this.r12, this.r22);
  }
  get lookVector(): Vector3 {
    return this.backVector.neg();
  }

  static fromAxisAngle(axis: Vector3, theta: number): CFrame {
    const u = axis.unit;
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    const t = 1 - c;
    const { x, y, z } = u;
    return new CFrame(
      Vector3.zero,
      t * x * x + c,
      t * x * y - s * z,
      t * x * z + s * y,
      t * x * y + s * z,
      t * y * y + c,
      t * y * z - s * x,
      t * x * z - s * y,
      t * y * z + s * x,
      t * z * z + c,
    );
  }

  static angles(rx: number, ry: number, rz: number): CFrame {
    // Roblox applies rotations in X -> Y -> Z order.
    return CFrame.fromAxisAngle(Vector3.xAxis, rx)
      .mul(CFrame.fromAxisAngle(Vector3.yAxis, ry))
      .mul(CFrame.fromAxisAngle(Vector3.zAxis, rz));
  }

  /** Builds a frame at `eye` whose lookVector points at `target`. */
  static lookAt(eye: Vector3, target: Vector3, up: Vector3 = Vector3.yAxis): CFrame {
    const back = eye.sub(target).unit;
    let right = up.cross(back);
    if (right.magnitude < 1e-6) right = Vector3.xAxis;
    right = right.unit;
    const realUp = back.cross(right);
    return new CFrame(
      eye,
      right.x,
      realUp.x,
      back.x,
      right.y,
      realUp.y,
      back.y,
      right.z,
      realUp.z,
      back.z,
    );
  }

  /** Rotates a direction by this frame's rotation, ignoring translation. */
  vectorToWorldSpace(v: Vector3): Vector3 {
    return new Vector3(
      this.r00 * v.x + this.r01 * v.y + this.r02 * v.z,
      this.r10 * v.x + this.r11 * v.y + this.r12 * v.z,
      this.r20 * v.x + this.r21 * v.y + this.r22 * v.z,
    );
  }

  vectorToObjectSpace(v: Vector3): Vector3 {
    return new Vector3(
      this.r00 * v.x + this.r10 * v.y + this.r20 * v.z,
      this.r01 * v.x + this.r11 * v.y + this.r21 * v.z,
      this.r02 * v.x + this.r12 * v.y + this.r22 * v.z,
    );
  }

  pointToWorldSpace(v: Vector3): Vector3 {
    return this.vectorToWorldSpace(v).add(this.position);
  }

  pointToObjectSpace(v: Vector3): Vector3 {
    return this.vectorToObjectSpace(v.sub(this.position));
  }

  mul(o: CFrame): CFrame;
  mul(o: Vector3): Vector3;
  mul(o: CFrame | Vector3): CFrame | Vector3 {
    if (o instanceof Vector3) return this.pointToWorldSpace(o);
    const p = this.pointToWorldSpace(o.position);
    return new CFrame(
      p,
      this.r00 * o.r00 + this.r01 * o.r10 + this.r02 * o.r20,
      this.r00 * o.r01 + this.r01 * o.r11 + this.r02 * o.r21,
      this.r00 * o.r02 + this.r01 * o.r12 + this.r02 * o.r22,
      this.r10 * o.r00 + this.r11 * o.r10 + this.r12 * o.r20,
      this.r10 * o.r01 + this.r11 * o.r11 + this.r12 * o.r21,
      this.r10 * o.r02 + this.r11 * o.r12 + this.r12 * o.r22,
      this.r20 * o.r00 + this.r21 * o.r10 + this.r22 * o.r20,
      this.r20 * o.r01 + this.r21 * o.r11 + this.r22 * o.r21,
      this.r20 * o.r02 + this.r21 * o.r12 + this.r22 * o.r22,
    );
  }

  add(v: Vector3): CFrame {
    return new CFrame(
      this.position.add(v),
      this.r00, this.r01, this.r02,
      this.r10, this.r11, this.r12,
      this.r20, this.r21, this.r22,
    );
  }

  sub(v: Vector3): CFrame {
    return this.add(v.neg());
  }

  /** Rotation is orthonormal, so the inverse is the transpose. */
  inverse(): CFrame {
    const p = this.vectorToObjectSpace(this.position).neg();
    return new CFrame(
      p,
      this.r00, this.r10, this.r20,
      this.r01, this.r11, this.r21,
      this.r02, this.r12, this.r22,
    );
  }

  /** Decomposes into Roblox's X->Y->Z Euler order. */
  toEulerAnglesXYZ(): [number, number, number] {
    const sy = Math.max(-1, Math.min(1, this.r02));
    const y = Math.asin(sy);
    if (Math.abs(sy) < 0.9999999) {
      return [Math.atan2(-this.r12, this.r22), y, Math.atan2(-this.r01, this.r00)];
    }
    // Gimbal lock: roll is arbitrary, fold it into yaw.
    return [Math.atan2(this.r21, this.r11), y, 0];
  }

  /** Column-major 4x4, ready to hand to a GPU or three.js. */
  toMatrix4(): number[] {
    return [
      this.r00, this.r10, this.r20, 0,
      this.r01, this.r11, this.r21, 0,
      this.r02, this.r12, this.r22, 0,
      this.position.x, this.position.y, this.position.z, 1,
    ];
  }

  toComponents(): number[] {
    return [
      this.position.x, this.position.y, this.position.z,
      this.r00, this.r01, this.r02,
      this.r10, this.r11, this.r12,
      this.r20, this.r21, this.r22,
    ];
  }

  static fromComponents(c: readonly number[]): CFrame {
    return new CFrame(
      new Vector3(c[0], c[1], c[2]),
      c[3], c[4], c[5],
      c[6], c[7], c[8],
      c[9], c[10], c[11],
    );
  }

  lerp(o: CFrame, alpha: number): CFrame {
    // Slerp via quaternions so blending stays on the rotation manifold.
    const a = quatFromCFrame(this);
    const b = quatFromCFrame(o);
    return cframeFromQuat(slerp(a, b, alpha), this.position.lerp(o.position, alpha));
  }

  toString(): string {
    return this.toComponents().join(", ");
  }
}

type Quat = [number, number, number, number];

function quatFromCFrame(c: CFrame): Quat {
  const trace = c.r00 + c.r11 + c.r22;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    return [(c.r21 - c.r12) / s, (c.r02 - c.r20) / s, (c.r10 - c.r01) / s, s / 4];
  }
  if (c.r00 > c.r11 && c.r00 > c.r22) {
    const s = Math.sqrt(1 + c.r00 - c.r11 - c.r22) * 2;
    return [s / 4, (c.r01 + c.r10) / s, (c.r02 + c.r20) / s, (c.r21 - c.r12) / s];
  }
  if (c.r11 > c.r22) {
    const s = Math.sqrt(1 + c.r11 - c.r00 - c.r22) * 2;
    return [(c.r01 + c.r10) / s, s / 4, (c.r12 + c.r21) / s, (c.r02 - c.r20) / s];
  }
  const s = Math.sqrt(1 + c.r22 - c.r00 - c.r11) * 2;
  return [(c.r02 + c.r20) / s, (c.r12 + c.r21) / s, s / 4, (c.r10 - c.r01) / s];
}

function cframeFromQuat(q: Quat, p: Vector3): CFrame {
  const [x, y, z, w] = q;
  return new CFrame(
    p,
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  );
}

function slerp(a: Quat, b: Quat, t: number): Quat {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let end = b;
  if (dot < 0) {
    end = [-b[0], -b[1], -b[2], -b[3]];
    dot = -dot;
  }
  if (dot > 0.9995) {
    const r: Quat = [
      a[0] + (end[0] - a[0]) * t,
      a[1] + (end[1] - a[1]) * t,
      a[2] + (end[2] - a[2]) * t,
      a[3] + (end[3] - a[3]) * t,
    ];
    const len = Math.hypot(r[0], r[1], r[2], r[3]) || 1;
    return [r[0] / len, r[1] / len, r[2] / len, r[3] / len];
  }
  const theta = Math.acos(dot);
  const sinTheta = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / sinTheta;
  const wb = Math.sin(t * theta) / sinTheta;
  return [
    a[0] * wa + end[0] * wb,
    a[1] * wa + end[1] * wb,
    a[2] * wa + end[2] * wb,
    a[3] * wa + end[3] * wb,
  ];
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
