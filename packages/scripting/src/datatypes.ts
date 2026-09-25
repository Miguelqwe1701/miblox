import { CFrame, Color3, UDim, UDim2, Vector2, Vector3 } from "@miblox/core";
import {
  LuaError,
  LuaTable,
  isUserdata,
  nativeFn,
  numberToString,
  userdata,
  type LuaUserdata,
  type LuaValue,
} from "@miblox/luau";

/**
 * Exposes the engine's value types to Luau as userdata with metatables, so that
 * `Vector3.new(1, 2, 3) * 2` and `cf1 * cf2` behave the way a Roblox script
 * expects. The engine objects themselves are stored unchanged inside the
 * userdata, so no conversion happens on the hot path.
 */

type Ctor<T> = new (...args: never[]) => T;

const metatables = new Map<string, LuaTable>();

function metatableFor(typeName: string): LuaTable {
  let mt = metatables.get(typeName);
  if (!mt) {
    mt = new LuaTable();
    mt.set("__type", typeName);
    metatables.set(typeName, mt);
  }
  return mt;
}

export function wrapValue(typeName: string, value: unknown): LuaUserdata {
  return userdata(typeName, value, metatableFor(typeName));
}

export function isWrapped(v: LuaValue, typeName: string): boolean {
  return isUserdata(v) && v.typeName === typeName;
}

/** Unwraps a userdata of the expected type, or throws a Lua-style error. */
export function expect<T>(v: LuaValue, typeName: string, ctor: Ctor<T>, where: string): T {
  if (isUserdata(v) && v.typeName === typeName && v.value instanceof (ctor as never)) {
    return v.value as T;
  }
  throw new LuaError(`${where} expected a ${typeName}`);
}

export const wrapVector3 = (v: Vector3): LuaUserdata => wrapValue("Vector3", v);
export const wrapVector2 = (v: Vector2): LuaUserdata => wrapValue("Vector2", v);
export const wrapCFrame = (v: CFrame): LuaUserdata => wrapValue("CFrame", v);
export const wrapColor3 = (v: Color3): LuaUserdata => wrapValue("Color3", v);
export const wrapUDim = (v: UDim): LuaUserdata => wrapValue("UDim", v);
export const wrapUDim2 = (v: UDim2): LuaUserdata => wrapValue("UDim2", v);

export function asVector3(v: LuaValue, where = "argument"): Vector3 {
  return expect(v, "Vector3", Vector3, where);
}
export function asCFrame(v: LuaValue, where = "argument"): CFrame {
  return expect(v, "CFrame", CFrame, where);
}
export function asColor3(v: LuaValue, where = "argument"): Color3 {
  return expect(v, "Color3", Color3, where);
}
export function asVector2(v: LuaValue, where = "argument"): Vector2 {
  return expect(v, "Vector2", Vector2, where);
}
export function asUDim(v: LuaValue, where = "argument"): UDim {
  return expect(v, "UDim", UDim, where);
}
export function asUDim2(v: LuaValue, where = "argument"): UDim2 {
  return expect(v, "UDim2", UDim2, where);
}

function num(v: LuaValue, fallback = 0): number {
  return typeof v === "number" ? v : fallback;
}

/** Installs metatables and constructors for the value types. */
export function installDatatypes(globals: LuaTable): void {
  installVector3(globals);
  installVector2(globals);
  installCFrame(globals);
  installColor3(globals);
  installUDim(globals);
  installUDim2(globals);
}

function installVector3(globals: LuaTable): void {
  const mt = metatableFor("Vector3");

  mt.set(
    "__index",
    nativeFn("Vector3.__index", (args) => {
      const self = args[0] as LuaUserdata;
      const v = self.value as Vector3;
      const key = args[1];
      switch (key) {
        case "X": case "x": return [v.x];
        case "Y": case "y": return [v.y];
        case "Z": case "z": return [v.z];
        case "Magnitude": return [v.magnitude];
        case "Unit": return [wrapVector3(v.unit)];
        case "Dot":
          return [nativeFn("Dot", (a) => [(a[0] as LuaUserdata).value as Vector3 ? ((a[0] as LuaUserdata).value as Vector3).dot(asVector3(a[1], "Vector3:Dot")) : 0])];
        case "Cross":
          return [
            nativeFn("Cross", (a) => [
              wrapVector3(
                ((a[0] as LuaUserdata).value as Vector3).cross(asVector3(a[1], "Vector3:Cross")),
              ),
            ]),
          ];
        case "Lerp":
          return [
            nativeFn("Lerp", (a) => [
              wrapVector3(
                ((a[0] as LuaUserdata).value as Vector3).lerp(
                  asVector3(a[1], "Vector3:Lerp"),
                  num(a[2]),
                ),
              ),
            ]),
          ];
        case "Abs":
          return [nativeFn("Abs", (a) => [wrapVector3(((a[0] as LuaUserdata).value as Vector3).abs())])];
        case "FuzzyEq":
          return [
            nativeFn("FuzzyEq", (a) => [
              ((a[0] as LuaUserdata).value as Vector3).equals(
                asVector3(a[1], "Vector3:FuzzyEq"),
                typeof a[2] === "number" ? a[2] : 1e-5,
              ),
            ]),
          ];
        default:
          throw new LuaError(`${String(key)} is not a valid member of Vector3`);
      }
    }),
  );

  const binary = (
    name: string,
    fn: (a: Vector3, b: LuaValue) => LuaValue,
  ): void => {
    mt.set(
      name,
      nativeFn(`Vector3.${name}`, (args) => {
        // Operands may arrive either way round for a commutative operator.
        const left = args[0];
        const right = args[1];
        if (isWrapped(left, "Vector3")) {
          return [fn((left as LuaUserdata).value as Vector3, right)];
        }
        return [fn((right as LuaUserdata).value as Vector3, left)];
      }),
    );
  };

  binary("__add", (a, b) => wrapVector3(a.add(asVector3(b, "Vector3 +"))));
  mt.set(
    "__sub",
    nativeFn("Vector3.__sub", (args) => {
      // Subtraction is not commutative, so order matters here.
      const a = asVector3(args[0], "Vector3 -");
      const b = asVector3(args[1], "Vector3 -");
      return [wrapVector3(a.sub(b))];
    }),
  );
  binary("__mul", (a, b) =>
    wrapVector3(typeof b === "number" ? a.mul(b) : a.mul(asVector3(b, "Vector3 *"))),
  );
  mt.set(
    "__div",
    nativeFn("Vector3.__div", (args) => {
      const a = asVector3(args[0], "Vector3 /");
      const b = args[1];
      return [wrapVector3(typeof b === "number" ? a.div(b) : a.div(asVector3(b, "Vector3 /")))];
    }),
  );
  mt.set("__unm", nativeFn("Vector3.__unm", (args) => [wrapVector3(asVector3(args[0]).neg())]));
  mt.set(
    "__eq",
    nativeFn("Vector3.__eq", (args) => {
      if (!isWrapped(args[0], "Vector3") || !isWrapped(args[1], "Vector3")) return [false];
      const a = asVector3(args[0]);
      const b = asVector3(args[1]);
      return [a.x === b.x && a.y === b.y && a.z === b.z];
    }),
  );
  mt.set("__tostring", nativeFn("Vector3.__tostring", (args) => [asVector3(args[0]).toString()]));

  const lib = new LuaTable();
  lib.set(
    "new",
    nativeFn("Vector3.new", (args) => [
      wrapVector3(new Vector3(num(args[0]), num(args[1]), num(args[2]))),
    ]),
  );
  lib.set("zero", wrapVector3(Vector3.zero));
  lib.set("one", wrapVector3(Vector3.one));
  lib.set("xAxis", wrapVector3(Vector3.xAxis));
  lib.set("yAxis", wrapVector3(Vector3.yAxis));
  lib.set("zAxis", wrapVector3(Vector3.zAxis));
  lib.frozen = true;
  globals.set("Vector3", lib);
}

function installVector2(globals: LuaTable): void {
  const mt = metatableFor("Vector2");
  mt.set(
    "__index",
    nativeFn("Vector2.__index", (args) => {
      const v = (args[0] as LuaUserdata).value as Vector2;
      switch (args[1]) {
        case "X": case "x": return [v.x];
        case "Y": case "y": return [v.y];
        case "Magnitude": return [v.magnitude];
        case "Unit": return [wrapVector2(v.unit)];
        default:
          throw new LuaError(`${String(args[1])} is not a valid member of Vector2`);
      }
    }),
  );
  mt.set(
    "__add",
    nativeFn("Vector2.__add", (args) => [
      wrapVector2(
        ((args[0] as LuaUserdata).value as Vector2).add((args[1] as LuaUserdata).value as Vector2),
      ),
    ]),
  );
  mt.set(
    "__sub",
    nativeFn("Vector2.__sub", (args) => [
      wrapVector2(
        ((args[0] as LuaUserdata).value as Vector2).sub((args[1] as LuaUserdata).value as Vector2),
      ),
    ]),
  );
  mt.set(
    "__tostring",
    nativeFn("Vector2.__tostring", (args) => [
      ((args[0] as LuaUserdata).value as Vector2).toString(),
    ]),
  );

  const lib = new LuaTable();
  lib.set(
    "new",
    nativeFn("Vector2.new", (args) => [wrapVector2(new Vector2(num(args[0]), num(args[1])))]),
  );
  lib.frozen = true;
  globals.set("Vector2", lib);
}

function installCFrame(globals: LuaTable): void {
  const mt = metatableFor("CFrame");

  mt.set(
    "__index",
    nativeFn("CFrame.__index", (args) => {
      const self = args[0] as LuaUserdata;
      const cf = self.value as CFrame;
      const key = args[1];
      switch (key) {
        case "Position": case "p": return [wrapVector3(cf.position)];
        case "X": return [cf.position.x];
        case "Y": return [cf.position.y];
        case "Z": return [cf.position.z];
        case "LookVector": return [wrapVector3(cf.lookVector)];
        case "RightVector": return [wrapVector3(cf.rightVector)];
        case "UpVector": return [wrapVector3(cf.upVector)];
        case "Rotation":
          return [wrapCFrame(new CFrame(
            Vector3.zero,
            cf.r00, cf.r01, cf.r02,
            cf.r10, cf.r11, cf.r12,
            cf.r20, cf.r21, cf.r22,
          ))];
        case "Inverse":
          return [nativeFn("Inverse", (a) => [wrapCFrame(asCFrame(a[0]).inverse())])];
        case "Lerp":
          return [
            nativeFn("Lerp", (a) => [
              wrapCFrame(asCFrame(a[0]).lerp(asCFrame(a[1], "CFrame:Lerp"), num(a[2]))),
            ]),
          ];
        case "ToWorldSpace":
          return [
            nativeFn("ToWorldSpace", (a) => [
              wrapCFrame(asCFrame(a[0]).mul(asCFrame(a[1], "CFrame:ToWorldSpace"))),
            ]),
          ];
        case "ToObjectSpace":
          return [
            nativeFn("ToObjectSpace", (a) => [
              wrapCFrame(asCFrame(a[0]).inverse().mul(asCFrame(a[1], "CFrame:ToObjectSpace"))),
            ]),
          ];
        case "PointToWorldSpace":
          return [
            nativeFn("PointToWorldSpace", (a) => [
              wrapVector3(asCFrame(a[0]).pointToWorldSpace(asVector3(a[1]))),
            ]),
          ];
        case "PointToObjectSpace":
          return [
            nativeFn("PointToObjectSpace", (a) => [
              wrapVector3(asCFrame(a[0]).pointToObjectSpace(asVector3(a[1]))),
            ]),
          ];
        case "VectorToWorldSpace":
          return [
            nativeFn("VectorToWorldSpace", (a) => [
              wrapVector3(asCFrame(a[0]).vectorToWorldSpace(asVector3(a[1]))),
            ]),
          ];
        case "ToEulerAnglesXYZ":
          return [nativeFn("ToEulerAnglesXYZ", (a) => asCFrame(a[0]).toEulerAnglesXYZ())];
        case "GetComponents":
          return [nativeFn("GetComponents", (a) => asCFrame(a[0]).toComponents())];
        default:
          throw new LuaError(`${String(key)} is not a valid member of CFrame`);
      }
    }),
  );

  mt.set(
    "__mul",
    nativeFn("CFrame.__mul", (args) => {
      const a = asCFrame(args[0], "CFrame *");
      const b = args[1];
      if (isWrapped(b, "Vector3")) return [wrapVector3(a.mul(asVector3(b)))];
      return [wrapCFrame(a.mul(asCFrame(b, "CFrame *")))];
    }),
  );
  mt.set(
    "__add",
    nativeFn("CFrame.__add", (args) => [
      wrapCFrame(asCFrame(args[0], "CFrame +").add(asVector3(args[1], "CFrame +"))),
    ]),
  );
  mt.set(
    "__sub",
    nativeFn("CFrame.__sub", (args) => [
      wrapCFrame(asCFrame(args[0], "CFrame -").sub(asVector3(args[1], "CFrame -"))),
    ]),
  );
  mt.set(
    "__eq",
    nativeFn("CFrame.__eq", (args) => {
      if (!isWrapped(args[0], "CFrame") || !isWrapped(args[1], "CFrame")) return [false];
      return [asCFrame(args[0]).toString() === asCFrame(args[1]).toString()];
    }),
  );
  mt.set("__tostring", nativeFn("CFrame.__tostring", (args) => [asCFrame(args[0]).toString()]));

  const lib = new LuaTable();
  lib.set(
    "new",
    nativeFn("CFrame.new", (args) => {
      // CFrame.new(Vector3), CFrame.new(x, y, z), or the 12-component form.
      if (isWrapped(args[0], "Vector3")) {
        const pos = asVector3(args[0]);
        if (isWrapped(args[1], "Vector3")) {
          return [wrapCFrame(CFrame.lookAt(pos, asVector3(args[1])))];
        }
        return [wrapCFrame(CFrame.fromPosition(pos))];
      }
      if (args.length >= 12) {
        return [wrapCFrame(CFrame.fromComponents(args.map((a) => num(a))))];
      }
      return [
        wrapCFrame(CFrame.fromPosition(new Vector3(num(args[0]), num(args[1]), num(args[2])))),
      ];
    }),
  );
  lib.set(
    "Angles",
    nativeFn("CFrame.Angles", (args) => [
      wrapCFrame(CFrame.angles(num(args[0]), num(args[1]), num(args[2]))),
    ]),
  );
  lib.set("fromEulerAnglesXYZ", lib.get("Angles"));
  lib.set(
    "fromAxisAngle",
    nativeFn("CFrame.fromAxisAngle", (args) => [
      wrapCFrame(CFrame.fromAxisAngle(asVector3(args[0]), num(args[1]))),
    ]),
  );
  lib.set(
    "lookAt",
    nativeFn("CFrame.lookAt", (args) => [
      wrapCFrame(
        CFrame.lookAt(
          asVector3(args[0], "CFrame.lookAt"),
          asVector3(args[1], "CFrame.lookAt"),
          isWrapped(args[2], "Vector3") ? asVector3(args[2]) : Vector3.yAxis,
        ),
      ),
    ]),
  );
  lib.set("identity", wrapCFrame(CFrame.identity));
  lib.frozen = true;
  globals.set("CFrame", lib);
}

function installColor3(globals: LuaTable): void {
  const mt = metatableFor("Color3");
  mt.set(
    "__index",
    nativeFn("Color3.__index", (args) => {
      const c = asColor3(args[0]);
      switch (args[1]) {
        case "R": case "r": return [c.r];
        case "G": case "g": return [c.g];
        case "B": case "b": return [c.b];
        case "Lerp":
          return [
            nativeFn("Lerp", (a) => [
              wrapColor3(asColor3(a[0]).lerp(asColor3(a[1], "Color3:Lerp"), num(a[2]))),
            ]),
          ];
        case "ToHex":
          return [nativeFn("ToHex", (a) => [asColor3(a[0]).toHex().toString(16).padStart(6, "0")])];
        default:
          throw new LuaError(`${String(args[1])} is not a valid member of Color3`);
      }
    }),
  );
  mt.set(
    "__eq",
    nativeFn("Color3.__eq", (args) => {
      if (!isWrapped(args[0], "Color3") || !isWrapped(args[1], "Color3")) return [false];
      return [asColor3(args[0]).toHex() === asColor3(args[1]).toHex()];
    }),
  );
  mt.set("__tostring", nativeFn("Color3.__tostring", (args) => [asColor3(args[0]).toString()]));

  const lib = new LuaTable();
  lib.set(
    "new",
    nativeFn("Color3.new", (args) => [
      wrapColor3(new Color3(num(args[0]), num(args[1]), num(args[2]))),
    ]),
  );
  lib.set(
    "fromRGB",
    nativeFn("Color3.fromRGB", (args) => [
      wrapColor3(Color3.fromRGB(num(args[0]), num(args[1]), num(args[2]))),
    ]),
  );
  lib.set(
    "fromHex",
    nativeFn("Color3.fromHex", (args) => {
      const raw = args[0];
      const hex = typeof raw === "string" ? parseInt(raw.replace(/^#/, ""), 16) : num(raw);
      return [wrapColor3(Color3.fromHex(hex))];
    }),
  );
  lib.frozen = true;
  globals.set("Color3", lib);
}

function installUDim(globals: LuaTable): void {
  const mt = metatableFor("UDim");
  mt.set(
    "__index",
    nativeFn("UDim.__index", (args) => {
      const u = asUDim(args[0]);
      switch (args[1]) {
        case "Scale": return [u.scale];
        case "Offset": return [u.offset];
        default:
          throw new LuaError(`${String(args[1])} is not a valid member of UDim`);
      }
    }),
  );
  mt.set("__add", nativeFn("UDim.__add", (a) => [wrapUDim(asUDim(a[0], "UDim +").add(asUDim(a[1], "UDim +")))]));
  mt.set("__sub", nativeFn("UDim.__sub", (a) => [wrapUDim(asUDim(a[0], "UDim -").sub(asUDim(a[1], "UDim -")))]));
  mt.set(
    "__eq",
    nativeFn("UDim.__eq", (a) => {
      if (!isWrapped(a[0], "UDim") || !isWrapped(a[1], "UDim")) return [false];
      const x = asUDim(a[0]);
      const y = asUDim(a[1]);
      return [x.scale === y.scale && x.offset === y.offset];
    }),
  );
  mt.set("__tostring", nativeFn("UDim.__tostring", (a) => [asUDim(a[0]).toString()]));

  const lib = new LuaTable();
  lib.set("new", nativeFn("UDim.new", (a) => [wrapUDim(new UDim(num(a[0]), num(a[1])))]));
  lib.frozen = true;
  globals.set("UDim", lib);
}

function installUDim2(globals: LuaTable): void {
  const mt = metatableFor("UDim2");
  mt.set(
    "__index",
    nativeFn("UDim2.__index", (args) => {
      const u = asUDim2(args[0]);
      switch (args[1]) {
        case "X": case "Width": return [wrapUDim(u.x)];
        case "Y": case "Height": return [wrapUDim(u.y)];
        case "Lerp":
          return [
            nativeFn("Lerp", (a) => [
              wrapUDim2(asUDim2(a[0]).lerp(asUDim2(a[1], "UDim2:Lerp"), num(a[2]))),
            ]),
          ];
        default:
          throw new LuaError(`${String(args[1])} is not a valid member of UDim2`);
      }
    }),
  );
  mt.set("__add", nativeFn("UDim2.__add", (a) => [wrapUDim2(asUDim2(a[0], "UDim2 +").add(asUDim2(a[1], "UDim2 +")))]));
  mt.set("__sub", nativeFn("UDim2.__sub", (a) => [wrapUDim2(asUDim2(a[0], "UDim2 -").sub(asUDim2(a[1], "UDim2 -")))]));
  mt.set(
    "__eq",
    nativeFn("UDim2.__eq", (a) => {
      if (!isWrapped(a[0], "UDim2") || !isWrapped(a[1], "UDim2")) return [false];
      return [asUDim2(a[0]).toArray().join() === asUDim2(a[1]).toArray().join()];
    }),
  );
  mt.set("__tostring", nativeFn("UDim2.__tostring", (a) => [asUDim2(a[0]).toString()]));

  const lib = new LuaTable();
  lib.set(
    "new",
    nativeFn("UDim2.new", (a) => {
      // UDim2.new(UDim, UDim) as well as the four-number form.
      if (isWrapped(a[0], "UDim")) {
        return [wrapUDim2(new UDim2(asUDim(a[0]), asUDim(a[1], "UDim2.new")))];
      }
      return [wrapUDim2(UDim2.new(num(a[0]), num(a[1]), num(a[2]), num(a[3])))];
    }),
  );
  lib.set("fromScale", nativeFn("UDim2.fromScale", (a) => [wrapUDim2(UDim2.fromScale(num(a[0]), num(a[1])))]));
  lib.set("fromOffset", nativeFn("UDim2.fromOffset", (a) => [wrapUDim2(UDim2.fromOffset(num(a[0]), num(a[1])))]));
  lib.frozen = true;
  globals.set("UDim2", lib);
}

/** Formats a number the way Lua's tostring would, for error messages. */
export function fmt(n: number): string {
  return numberToString(n);
}
