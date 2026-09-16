import { test } from "node:test";
import assert from "node:assert/strict";
import { CFrame, Vector3, Color3 } from "../dist/index.js";

const closeTo = (a, b, eps = 1e-6) =>
  assert.ok(Math.abs(a - b) < eps, `${a} !~= ${b}`);

test("Vector3 arithmetic", () => {
  const a = new Vector3(1, 2, 3);
  const b = new Vector3(4, 5, 6);
  assert.deepEqual(a.add(b).toArray(), [5, 7, 9]);
  assert.deepEqual(a.sub(b).toArray(), [-3, -3, -3]);
  assert.equal(a.dot(b), 32);
  assert.deepEqual(a.cross(b).toArray(), [-3, 6, -3]);
  closeTo(new Vector3(3, 4, 0).magnitude, 5);
  closeTo(new Vector3(3, 4, 0).unit.magnitude, 1);
});

test("Vector3.unit of zero does not produce NaN", () => {
  assert.deepEqual(Vector3.zero.unit.toArray(), [0, 0, 0]);
});

test("CFrame inverse round-trips a point", () => {
  const cf = CFrame.angles(0.3, 1.1, -0.7).add(new Vector3(10, -4, 6));
  const p = new Vector3(2, 3, 5);
  const there = cf.pointToWorldSpace(p);
  const back = cf.inverse().pointToWorldSpace(there);
  closeTo(back.x, p.x, 1e-9);
  closeTo(back.y, p.y, 1e-9);
  closeTo(back.z, p.z, 1e-9);
});

test("CFrame multiplication composes transforms", () => {
  const a = CFrame.angles(0, Math.PI / 2, 0);
  const b = CFrame.fromPosition(new Vector3(0, 0, -5));
  const composed = a.mul(b);
  // Rotating 90 degrees about Y maps -Z onto -X.
  closeTo(composed.position.x, -5, 1e-9);
  closeTo(composed.position.z, 0, 1e-9);
});

test("CFrame.lookAt aims its lookVector at the target", () => {
  const cf = CFrame.lookAt(new Vector3(0, 0, 0), new Vector3(0, 0, -10));
  const look = cf.lookVector;
  closeTo(look.x, 0, 1e-9);
  closeTo(look.z, -1, 1e-9);
});

test("Euler round-trip through a CFrame", () => {
  const [x, y, z] = CFrame.angles(0.4, -0.9, 1.2).toEulerAnglesXYZ();
  closeTo(x, 0.4, 1e-6);
  closeTo(y, -0.9, 1e-6);
  closeTo(z, 1.2, 1e-6);
});

test("CFrame component round-trip", () => {
  const cf = CFrame.angles(0.1, 0.2, 0.3).add(new Vector3(1, 2, 3));
  const back = CFrame.fromComponents(cf.toComponents());
  assert.equal(back.toString(), cf.toString());
});

test("CFrame lerp stays normalised", () => {
  const mid = CFrame.identity.lerp(CFrame.angles(0, Math.PI, 0), 0.5);
  closeTo(mid.rightVector.magnitude, 1, 1e-9);
});

test("Color3 hex round-trip", () => {
  assert.equal(Color3.fromHex(0x3b6ea5).toHex(), 0x3b6ea5);
  assert.equal(Color3.fromRGB(255, 0, 128).toHex(), 0xff0080);
});
