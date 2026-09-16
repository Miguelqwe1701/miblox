/**
 * Luau runtime values.
 *
 * nil is represented by `undefined`, never `null`, so that a JS `null` coming
 * from host code is a distinct (and invalid) value rather than a silent nil.
 */

export type LuaValue =
  | undefined
  | boolean
  | number
  | string
  | LuaTable
  | LuaFunction
  | Coroutine
  | LuaUserdata;

/** Host objects exposed to scripts (Instances, Vector3, and so on). */
export interface LuaUserdata {
  readonly __userdata: true;
  readonly typeName: string;
  readonly value: unknown;
  metatable?: LuaTable;
}

export function isUserdata(v: LuaValue): v is LuaUserdata {
  return typeof v === "object" && v !== null && (v as LuaUserdata).__userdata === true;
}

export function userdata(typeName: string, value: unknown, metatable?: LuaTable): LuaUserdata {
  return { __userdata: true, typeName, value, metatable };
}

export class LuaError extends Error {
  constructor(
    /** The raw error value, which in Lua may be any value, not just a string. */
    readonly value: LuaValue,
    readonly traceback?: string,
  ) {
    super(typeof value === "string" ? value : tostring(value));
    this.name = "LuaError";
  }
}

export function luaError(message: string): never {
  throw new LuaError(message);
}

/**
 * A Lua table: a contiguous array part plus a hash part, matching Lua's own
 * split so that `#`, ipairs and table.insert stay O(1) on ordinary lists.
 */
export class LuaTable {
  /** Values for integer keys 1..arr.length. */
  private arr: LuaValue[] = [];
  private hash = new Map<LuaValue, LuaValue>();
  metatable: LuaTable | undefined;
  /** Blocks writes; used for the sandboxed global table and frozen enums. */
  frozen = false;

  constructor(entries?: Iterable<[LuaValue, LuaValue]>) {
    if (entries) for (const [k, v] of entries) this.set(k, v);
  }

  static fromArray(values: LuaValue[]): LuaTable {
    const t = new LuaTable();
    for (let i = 0; i < values.length; i++) t.set(i + 1, values[i]);
    return t;
  }

  static fromObject(obj: Record<string, LuaValue>): LuaTable {
    const t = new LuaTable();
    for (const [k, v] of Object.entries(obj)) t.set(k, v);
    return t;
  }

  /** Raw get: ignores metatables, like rawget. */
  get(key: LuaValue): LuaValue {
    if (typeof key === "number") {
      // -0 and 0 are the same key in Lua.
      const k = key === 0 ? 0 : key;
      if (Number.isInteger(k) && k >= 1 && k <= this.arr.length) return this.arr[k - 1];
      return this.hash.get(k);
    }
    if (key === undefined) return undefined;
    return this.hash.get(key);
  }

  set(key: LuaValue, value: LuaValue): void {
    if (this.frozen) luaError("attempt to modify a readonly table");
    if (key === undefined) luaError("table index is nil");
    if (typeof key === "number") {
      if (Number.isNaN(key)) luaError("table index is NaN");
      const k = key === 0 ? 0 : key;
      if (Number.isInteger(k) && k >= 1) {
        if (k <= this.arr.length) {
          this.arr[k - 1] = value;
          // Dropping the last element shrinks the array part.
          if (value === undefined && k === this.arr.length) {
            this.arr.pop();
            while (this.arr.length > 0 && this.arr[this.arr.length - 1] === undefined) {
              this.arr.pop();
            }
          }
          return;
        }
        if (k === this.arr.length + 1) {
          if (value === undefined) {
            this.hash.delete(k);
            return;
          }
          this.arr.push(value);
          // Absorb any keys the hash part was holding just past the border.
          let next = this.arr.length + 1;
          while (this.hash.has(next)) {
            this.arr.push(this.hash.get(next));
            this.hash.delete(next);
            next++;
          }
          return;
        }
      }
    }
    if (value === undefined) this.hash.delete(key);
    else this.hash.set(key, value);
  }

  /** The `#` border. O(1) for ordinary sequences. */
  get length(): number {
    return this.arr.length;
  }

  /** Iteration order: array part first, then hash insertion order. */
  *entries(): IterableIterator<[LuaValue, LuaValue]> {
    for (let i = 0; i < this.arr.length; i++) {
      if (this.arr[i] !== undefined) yield [i + 1, this.arr[i]];
    }
    for (const [k, v] of this.hash) {
      if (v !== undefined) yield [k, v];
    }
  }

  /** Implements `next`, which must be resumable from an arbitrary key. */
  nextKey(key: LuaValue): [LuaValue, LuaValue] | undefined {
    const all = [...this.entries()];
    if (key === undefined) return all[0];
    const index = all.findIndex(([k]) => k === key);
    if (index === -1) return undefined;
    return all[index + 1];
  }

  toArray(): LuaValue[] {
    return this.arr.slice();
  }

  get hashSize(): number {
    return this.hash.size;
  }
}

export type NativeFn = (args: LuaValue[]) => LuaValue[];
/** Natives that can yield run as generators driven by the scheduler. */
export type NativeGenFn = (args: LuaValue[]) => Generator<YieldRequest, LuaValue[], LuaValue[]>;

export interface LuaFunction {
  readonly __luafunction: true;
  name: string;
  /** Native implementation, or undefined for an interpreted closure. */
  native?: NativeFn;
  nativeGen?: NativeGenFn;
  /** Set for interpreted closures; opaque to this module. */
  proto?: unknown;
  upvalues?: unknown;
}

export function isFunction(v: LuaValue): v is LuaFunction {
  return typeof v === "object" && v !== null && (v as LuaFunction).__luafunction === true;
}

export function nativeFn(name: string, fn: NativeFn): LuaFunction {
  return { __luafunction: true, name, native: fn };
}

export function yieldingFn(name: string, fn: NativeGenFn): LuaFunction {
  return { __luafunction: true, name, nativeGen: fn };
}

/** What a running thread hands back to the scheduler when it suspends. */
export type YieldRequest =
  | { kind: "yield"; values: LuaValue[] }
  | { kind: "wait"; seconds: number }
  | { kind: "waitSignal"; signal: unknown }
  | { kind: "waitPromise"; promise: Promise<LuaValue[]> };

export type CoroutineStatus = "suspended" | "running" | "normal" | "dead";

export class Coroutine {
  readonly __coroutine = true;
  status: CoroutineStatus = "suspended";
  /** The generator driving this thread, created on first resume. */
  gen?: Generator<YieldRequest, LuaValue[], LuaValue[]>;
  /** Set when the body threw, so resume can report it. */
  error?: LuaError;

  constructor(readonly fn: LuaFunction) {}
}

export function isCoroutine(v: LuaValue): v is Coroutine {
  return typeof v === "object" && v !== null && (v as Coroutine).__coroutine === true;
}

// ---------------------------------------------------------------------------
// Type names, truthiness and coercion
// ---------------------------------------------------------------------------

export function luaType(v: LuaValue): string {
  if (v === undefined) return "nil";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number") return "number";
  if (typeof v === "string") return "string";
  if (v instanceof LuaTable) return "table";
  if (isFunction(v)) return "function";
  if (isCoroutine(v)) return "thread";
  if (isUserdata(v)) return "userdata";
  return "userdata";
}

/** Only nil and false are falsy; 0 and "" are true, as in Lua. */
export function truthy(v: LuaValue): boolean {
  return v !== undefined && v !== false;
}

export function tostring(v: LuaValue): string {
  if (v === undefined) return "nil";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return numberToString(v);
  if (typeof v === "string") return v;
  if (v instanceof LuaTable) {
    const mt = v.metatable?.get("__tostring");
    if (isFunction(mt) && mt.native) return tostring(mt.native([v])[0]);
    const name = v.metatable?.get("__type");
    return `${typeof name === "string" ? name : "table"}: 0x${idOf(v)}`;
  }
  if (isFunction(v)) return `function: ${v.name || "anonymous"}`;
  if (isCoroutine(v)) return `thread: 0x${idOf(v)}`;
  if (isUserdata(v)) {
    const mt = v.metatable?.get("__tostring");
    if (isFunction(mt) && mt.native) return tostring(mt.native([v])[0]);
    return String(v.value);
  }
  return String(v);
}

export function numberToString(n: number): string {
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  if (!Number.isFinite(n)) return Number.isNaN(n) ? "nan" : n > 0 ? "inf" : "-inf";
  // Lua's default %.14g formatting.
  const s = n.toPrecision(14);
  return s.includes("e") ? String(n) : trimZeros(s);
}

function trimZeros(s: string): string {
  if (!s.includes(".")) return s;
  return s.replace(/0+$/, "").replace(/\.$/, "");
}

const objectIds = new WeakMap<object, string>();
let nextObjectId = 1;
function idOf(obj: object): string {
  let id = objectIds.get(obj);
  if (!id) {
    id = (nextObjectId++).toString(16).padStart(8, "0");
    objectIds.set(obj, id);
  }
  return id;
}

/** String->number coercion used by arithmetic; returns undefined on failure. */
export function tonumber(v: LuaValue, base?: number): number | undefined {
  if (base !== undefined && base !== 10) {
    if (typeof v !== "string") return undefined;
    const parsed = parseInt(v.trim(), base);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  if (typeof v === "number") return v;
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  if (s === "") return undefined;
  if (/^0[xX][0-9a-fA-F]+$/.test(s)) return parseInt(s, 16);
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return undefined;
  const n = Number(s);
  return Number.isNaN(n) ? undefined : n;
}

/** Numeric coercion for arithmetic, which raises rather than returning nil. */
export function arithNumber(v: LuaValue, op: string): number {
  const n = tonumber(v);
  if (n === undefined) {
    luaError(`attempt to perform arithmetic (${op}) on a ${luaType(v)} value`);
  }
  return n;
}

export function rawEquals(a: LuaValue, b: LuaValue): boolean {
  // Lua has no -0/+0 distinction and NaN ~= NaN, which is JS === semantics.
  return a === b;
}

export function getMetatable(v: LuaValue): LuaTable | undefined {
  if (v instanceof LuaTable) return v.metatable;
  if (isUserdata(v)) return v.metatable;
  if (typeof v === "string") return stringMetatable;
  return undefined;
}

/** Set by the stdlib so that ("x"):upper() resolves through the string table. */
export let stringMetatable: LuaTable | undefined;
export function setStringMetatable(mt: LuaTable): void {
  stringMetatable = mt;
}

export function getMetamethod(v: LuaValue, name: string): LuaValue {
  return getMetatable(v)?.get(name);
}
