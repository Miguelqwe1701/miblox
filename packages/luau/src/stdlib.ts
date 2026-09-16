import {
  Coroutine,
  LuaError,
  LuaTable,
  type LuaFunction,
  type LuaValue,
  type YieldRequest,
  isCoroutine,
  isFunction,
  luaType,
  nativeFn,
  numberToString,
  rawEquals,
  setStringMetatable,
  tonumber,
  tostring,
  truthy,
  yieldingFn,
} from "./values.js";
import type { Interpreter } from "./interpreter.js";
import { capturesOf, patternFind } from "./patterns.js";

/** Services the host provides to the `task` library and friends. */
export interface Host {
  /** Seconds since the game started. */
  now(): number;
  /** Queues `fn` to run as a new thread after `delay` seconds. */
  spawn(fn: LuaFunction, args: LuaValue[], delay: number, deferred?: boolean): Coroutine;
  cancel(co: Coroutine): void;
}

function arg(args: LuaValue[], i: number): LuaValue {
  return args[i];
}

function checkNumber(args: LuaValue[], i: number, fname: string): number {
  const n = tonumber(args[i]);
  if (n === undefined) {
    throw new LuaError(
      `invalid argument #${i + 1} to '${fname}' (number expected, got ${luaType(args[i])})`,
    );
  }
  return n;
}

function checkString(args: LuaValue[], i: number, fname: string): string {
  const v = args[i];
  if (typeof v === "string") return v;
  if (typeof v === "number") return numberToString(v);
  throw new LuaError(
    `invalid argument #${i + 1} to '${fname}' (string expected, got ${luaType(v)})`,
  );
}

function checkTable(args: LuaValue[], i: number, fname: string): LuaTable {
  const v = args[i];
  if (v instanceof LuaTable) return v;
  throw new LuaError(
    `invalid argument #${i + 1} to '${fname}' (table expected, got ${luaType(v)})`,
  );
}

function checkFunction(args: LuaValue[], i: number, fname: string): LuaFunction {
  const v = args[i];
  if (isFunction(v)) return v;
  throw new LuaError(
    `invalid argument #${i + 1} to '${fname}' (function expected, got ${luaType(v)})`,
  );
}

/** Converts a Lua 1-based, possibly negative index into a 0-based offset. */
function strIndex(i: number, len: number): number {
  if (i > 0) return i - 1;
  if (i === 0) return 0;
  return Math.max(len + i, 0);
}

export function installStdlib(interp: Interpreter, host: Host): void {
  const g = interp.globals;

  // -- base ---------------------------------------------------------------

  g.set("_G", g);
  g.set("_VERSION", "Luau (MiBlox)");

  g.set(
    "print",
    yieldingFn("print", function* (args) {
      const parts: string[] = [];
      for (const value of args) parts.push(yield* interp.tostringMeta(value, 0));
      interp.onPrint(parts.join("\t"));
      return [];
    }),
  );

  g.set(
    "warn",
    yieldingFn("warn", function* (args) {
      const parts: string[] = [];
      for (const value of args) parts.push(yield* interp.tostringMeta(value, 0));
      interp.onWarn(parts.join("\t"));
      return [];
    }),
  );

  g.set("type", nativeFn("type", (args) => [luaType(arg(args, 0))]));

  g.set(
    "typeof",
    nativeFn("typeof", (args) => {
      const v = arg(args, 0);
      // Roblox's typeof reports the userdata's own type name.
      if (v && typeof v === "object" && "typeName" in v) {
        return [(v as { typeName: string }).typeName];
      }
      return [luaType(v)];
    }),
  );

  g.set(
    "tostring",
    yieldingFn("tostring", function* (args) {
      return [yield* interp.tostringMeta(arg(args, 0), 0)];
    }),
  );

  g.set(
    "tonumber",
    nativeFn("tonumber", (args) => {
      const base = args[1] === undefined ? undefined : checkNumber(args, 1, "tonumber");
      return [tonumber(arg(args, 0), base)];
    }),
  );

  g.set(
    "rawget",
    nativeFn("rawget", (args) => [checkTable(args, 0, "rawget").get(arg(args, 1))]),
  );
  g.set(
    "rawset",
    nativeFn("rawset", (args) => {
      checkTable(args, 0, "rawset").set(arg(args, 1), arg(args, 2));
      return [args[0]];
    }),
  );
  g.set("rawequal", nativeFn("rawequal", (args) => [rawEquals(arg(args, 0), arg(args, 1))]));
  g.set(
    "rawlen",
    nativeFn("rawlen", (args) => {
      const v = arg(args, 0);
      if (typeof v === "string") return [v.length];
      return [checkTable(args, 0, "rawlen").length];
    }),
  );

  g.set(
    "setmetatable",
    nativeFn("setmetatable", (args) => {
      const t = checkTable(args, 0, "setmetatable");
      const mt = args[1];
      if (mt === undefined) t.metatable = undefined;
      else if (mt instanceof LuaTable) t.metatable = mt;
      else throw new LuaError("bad argument #2 to 'setmetatable' (nil or table expected)");
      return [t];
    }),
  );

  g.set(
    "getmetatable",
    nativeFn("getmetatable", (args) => {
      const v = arg(args, 0);
      const mt = v instanceof LuaTable ? v.metatable : undefined;
      if (!mt) return [undefined];
      // __metatable hides the real metatable, as Lua specifies.
      const guard = mt.get("__metatable");
      return [guard !== undefined ? guard : mt];
    }),
  );

  g.set(
    "assert",
    nativeFn("assert", (args) => {
      if (!truthy(arg(args, 0))) {
        const message = args.length > 1 ? args[1] : "assertion failed!";
        throw new LuaError(message);
      }
      return args;
    }),
  );

  g.set(
    "error",
    nativeFn("error", (args) => {
      const value = arg(args, 0);
      const level = args[1] === undefined ? 1 : checkNumber(args, 1, "error");
      if (typeof value === "string" && level > 0) {
        const frame = interp.callStack[interp.callStack.length - 1];
        throw new LuaError(
          frame ? `${frame.chunkName}:${frame.line}: ${value}` : value,
          interp.traceback(),
        );
      }
      throw new LuaError(value, interp.traceback());
    }),
  );

  g.set(
    "pcall",
    yieldingFn("pcall", function* (args) {
      const fn = args[0];
      try {
        const results = yield* interp.call(fn, args.slice(1));
        return [true, ...results];
      } catch (err) {
        if (err instanceof LuaError) return [false, err.value];
        // A host bug should surface rather than masquerade as a script error.
        if (err instanceof RangeError) return [false, "stack overflow"];
        return [false, String(err)];
      }
    }),
  );

  g.set(
    "xpcall",
    yieldingFn("xpcall", function* (args) {
      const fn = args[0];
      const handler = args[1];
      try {
        const results = yield* interp.call(fn, args.slice(2));
        return [true, ...results];
      } catch (err) {
        const value = err instanceof LuaError ? err.value : String(err);
        const handled = yield* interp.call(handler, [value]);
        return [false, ...handled];
      }
    }),
  );

  g.set(
    "select",
    nativeFn("select", (args) => {
      const selector = arg(args, 0);
      const rest = args.slice(1);
      if (selector === "#") return [rest.length];
      const n = checkNumber(args, 0, "select");
      if (n < 0) return rest.slice(rest.length + n);
      return rest.slice(n - 1);
    }),
  );

  const nextFn = nativeFn("next", (args) => {
    const t = checkTable(args, 0, "next");
    const entry = t.nextKey(arg(args, 1));
    return entry ? [entry[0], entry[1]] : [undefined];
  });
  g.set("next", nextFn);

  g.set(
    "pairs",
    nativeFn("pairs", (args) => {
      const t = arg(args, 0);
      if (t instanceof LuaTable) {
        const meta = t.metatable?.get("__pairs");
        if (isFunction(meta) && meta.native) return meta.native([t]);
      }
      checkTable(args, 0, "pairs");
      return [nextFn, t, undefined];
    }),
  );

  g.set(
    "ipairs",
    nativeFn("ipairs", (args) => {
      const t = checkTable(args, 0, "ipairs");
      const iter = nativeFn("ipairs_iterator", (iterArgs) => {
        const i = (iterArgs[1] as number) + 1;
        const value = t.get(i);
        return value === undefined ? [undefined] : [i, value];
      });
      return [iter, t, 0];
    }),
  );

  const unpack = nativeFn("unpack", (args) => {
    const t = checkTable(args, 0, "unpack");
    const from = args[1] === undefined ? 1 : checkNumber(args, 1, "unpack");
    const to = args[2] === undefined ? t.length : checkNumber(args, 2, "unpack");
    const out: LuaValue[] = [];
    for (let i = from; i <= to; i++) out.push(t.get(i));
    return out;
  });
  g.set("unpack", unpack);

  // -- string -------------------------------------------------------------

  const stringLib = new LuaTable();
  stringLib.set("len", nativeFn("len", (a) => [checkString(a, 0, "len").length]));
  stringLib.set("upper", nativeFn("upper", (a) => [checkString(a, 0, "upper").toUpperCase()]));
  stringLib.set("lower", nativeFn("lower", (a) => [checkString(a, 0, "lower").toLowerCase()]));
  stringLib.set(
    "reverse",
    nativeFn("reverse", (a) => [[...checkString(a, 0, "reverse")].reverse().join("")]),
  );
  stringLib.set(
    "rep",
    nativeFn("rep", (a) => {
      const s = checkString(a, 0, "rep");
      const n = Math.floor(checkNumber(a, 1, "rep"));
      const sep = a[2] === undefined ? "" : checkString(a, 2, "rep");
      if (n <= 0) return [""];
      if (s.length * n > 50_000_000) throw new LuaError("resulting string too large");
      return [Array(n).fill(s).join(sep)];
    }),
  );
  stringLib.set(
    "sub",
    nativeFn("sub", (a) => {
      const s = checkString(a, 0, "sub");
      const len = s.length;
      let i = a[1] === undefined ? 1 : Math.floor(checkNumber(a, 1, "sub"));
      let j = a[2] === undefined ? -1 : Math.floor(checkNumber(a, 2, "sub"));
      if (i < 0) i = Math.max(len + i + 1, 1);
      else if (i === 0) i = 1;
      if (j < 0) j = len + j + 1;
      else if (j > len) j = len;
      return [i > j ? "" : s.slice(i - 1, j)];
    }),
  );
  stringLib.set(
    "byte",
    nativeFn("byte", (a) => {
      const s = checkString(a, 0, "byte");
      const i = a[1] === undefined ? 1 : Math.floor(checkNumber(a, 1, "byte"));
      const j = a[2] === undefined ? i : Math.floor(checkNumber(a, 2, "byte"));
      const out: LuaValue[] = [];
      for (let k = strIndex(i, s.length); k < Math.min(strIndex(j, s.length) + 1, s.length); k++) {
        out.push(s.charCodeAt(k));
      }
      return out;
    }),
  );
  stringLib.set(
    "char",
    nativeFn("char", (a) => [a.map((c) => String.fromCharCode(Number(c))).join("")]),
  );
  stringLib.set(
    "split",
    nativeFn("split", (a) => {
      const s = checkString(a, 0, "split");
      const sep = a[1] === undefined ? "," : checkString(a, 1, "split");
      return [LuaTable.fromArray(sep === "" ? [...s] : s.split(sep))];
    }),
  );
  stringLib.set("format", nativeFn("format", (a) => [luaFormat(a)]));

  stringLib.set(
    "find",
    nativeFn("find", (a) => {
      const s = checkString(a, 0, "find");
      const pattern = checkString(a, 1, "find");
      const init = a[2] === undefined ? 1 : Math.floor(checkNumber(a, 2, "find"));
      const plain = truthy(a[3]);
      const start = init < 0 ? Math.max(s.length + init, 0) : Math.max(init - 1, 0);
      if (start > s.length) return [undefined];
      if (plain) {
        const index = s.indexOf(pattern, start);
        return index === -1 ? [undefined] : [index + 1, index + pattern.length];
      }
      const result = patternFind(s, pattern, start);
      if (!result) return [undefined];
      return [result.start + 1, result.end, ...capturesOf(s, result, false)];
    }),
  );

  stringLib.set(
    "match",
    nativeFn("match", (a) => {
      const s = checkString(a, 0, "match");
      const pattern = checkString(a, 1, "match");
      const init = a[2] === undefined ? 1 : Math.floor(checkNumber(a, 2, "match"));
      const start = init < 0 ? Math.max(s.length + init, 0) : Math.max(init - 1, 0);
      const result = patternFind(s, pattern, start);
      return result ? capturesOf(s, result) : [undefined];
    }),
  );

  stringLib.set(
    "gmatch",
    nativeFn("gmatch", (a) => {
      const s = checkString(a, 0, "gmatch");
      const pattern = checkString(a, 1, "gmatch");
      let pos = 0;
      const iter = nativeFn("gmatch_iterator", () => {
        while (pos <= s.length) {
          const result = patternFind(s, pattern, pos);
          if (!result) return [undefined];
          // An empty match must still advance, or this loops forever.
          pos = result.end > result.start ? result.end : result.start + 1;
          return capturesOf(s, result);
        }
        return [undefined];
      });
      return [iter];
    }),
  );

  stringLib.set(
    "gsub",
    yieldingFn("gsub", function* (a) {
      const s = checkString(a, 0, "gsub");
      const pattern = checkString(a, 1, "gsub");
      const replacement = a[2];
      const maxN = a[3] === undefined ? Infinity : checkNumber(a, 3, "gsub");

      let out = "";
      let pos = 0;
      let count = 0;
      while (count < maxN && pos <= s.length) {
        const result = patternFind(s, pattern, pos);
        if (!result) break;
        out += s.slice(pos, result.start);
        const whole = s.slice(result.start, result.end);
        const caps = capturesOf(s, result);
        let replaced: LuaValue;

        if (typeof replacement === "string" || typeof replacement === "number") {
          const text = typeof replacement === "number" ? numberToString(replacement) : replacement;
          replaced = text.replace(/%([%0-9])/g, (_, d: string) => {
            if (d === "%") return "%";
            const index = Number(d);
            if (index === 0) return whole;
            const cap = caps[index - 1];
            return cap === undefined ? "" : String(cap);
          });
        } else if (replacement instanceof LuaTable) {
          replaced = replacement.get(caps[0] as LuaValue);
        } else if (isFunction(replacement)) {
          replaced = (yield* interp.call(replacement, caps as LuaValue[]))[0];
        } else {
          throw new LuaError("bad argument #3 to 'gsub' (string/function/table expected)");
        }

        // A false or nil replacement keeps the original text.
        out += truthy(replaced) ? tostring(replaced) : whole;
        count++;

        if (result.end > result.start) {
          pos = result.end;
        } else {
          if (result.start < s.length) out += s[result.start];
          pos = result.start + 1;
        }
      }
      out += s.slice(pos);
      return [out, count];
    }),
  );

  g.set("string", stringLib);

  // Lets ("x"):upper() resolve, since strings have no metatable of their own.
  const stringMeta = new LuaTable();
  stringMeta.set("__index", stringLib);
  setStringMetatable(stringMeta);

  // -- table --------------------------------------------------------------

  const tableLib = new LuaTable();
  tableLib.set(
    "insert",
    nativeFn("insert", (a) => {
      const t = checkTable(a, 0, "insert");
      if (a.length >= 3) {
        const pos = Math.floor(checkNumber(a, 1, "insert"));
        const n = t.length;
        if (pos < 1 || pos > n + 1) throw new LuaError("bad argument #2 to 'insert' (position out of bounds)");
        for (let i = n; i >= pos; i--) t.set(i + 1, t.get(i));
        t.set(pos, a[2]);
      } else {
        t.set(t.length + 1, a[1]);
      }
      return [];
    }),
  );
  tableLib.set(
    "remove",
    nativeFn("remove", (a) => {
      const t = checkTable(a, 0, "remove");
      const n = t.length;
      const pos = a[1] === undefined ? n : Math.floor(checkNumber(a, 1, "remove"));
      if (n === 0 && a[1] === undefined) return [undefined];
      if (n > 0 && (pos < 1 || pos > n + 1)) {
        throw new LuaError("bad argument #2 to 'remove' (position out of bounds)");
      }
      const removed = t.get(pos);
      for (let i = pos; i < n; i++) t.set(i, t.get(i + 1));
      if (pos <= n) t.set(n, undefined);
      return [removed];
    }),
  );
  tableLib.set(
    "concat",
    nativeFn("concat", (a) => {
      const t = checkTable(a, 0, "concat");
      const sep = a[1] === undefined ? "" : checkString(a, 1, "concat");
      const from = a[2] === undefined ? 1 : checkNumber(a, 2, "concat");
      const to = a[3] === undefined ? t.length : checkNumber(a, 3, "concat");
      const parts: string[] = [];
      for (let i = from; i <= to; i++) {
        const v = t.get(i);
        if (typeof v !== "string" && typeof v !== "number") {
          throw new LuaError(`invalid value (at index ${i}) in table for 'concat'`);
        }
        parts.push(typeof v === "number" ? numberToString(v) : v);
      }
      return [parts.join(sep)];
    }),
  );
  tableLib.set("unpack", unpack);
  tableLib.set(
    "pack",
    nativeFn("pack", (a) => {
      const t = LuaTable.fromArray(a);
      t.set("n", a.length);
      return [t];
    }),
  );
  tableLib.set(
    "find",
    nativeFn("find", (a) => {
      const t = checkTable(a, 0, "find");
      const needle = a[1];
      const init = a[2] === undefined ? 1 : checkNumber(a, 2, "find");
      for (let i = init; i <= t.length; i++) {
        if (rawEquals(t.get(i), needle)) return [i];
      }
      return [undefined];
    }),
  );
  tableLib.set(
    "clear",
    nativeFn("clear", (a) => {
      const t = checkTable(a, 0, "clear");
      for (const [k] of [...t.entries()]) t.set(k, undefined);
      return [];
    }),
  );
  tableLib.set(
    "clone",
    nativeFn("clone", (a) => {
      const t = checkTable(a, 0, "clone");
      const copy = new LuaTable();
      for (const [k, v] of t.entries()) copy.set(k, v);
      copy.metatable = t.metatable;
      return [copy];
    }),
  );
  tableLib.set(
    "create",
    nativeFn("create", (a) => {
      const count = Math.floor(checkNumber(a, 0, "create"));
      const value = a[1];
      const t = new LuaTable();
      for (let i = 1; i <= count; i++) t.set(i, value);
      return [t];
    }),
  );
  tableLib.set(
    "sort",
    yieldingFn("sort", function* (a) {
      const t = checkTable(a, 0, "sort");
      const comparator = a[1];
      const values = t.toArray();
      // Extracted, sorted with an explicit comparison, then written back: the
      // comparator may yield, so Array.prototype.sort cannot drive it.
      const compare = function* (x: LuaValue, y: LuaValue): Generator<YieldRequest, boolean, LuaValue[]> {
        if (comparator === undefined) {
          return truthy(yield* interp.binaryOp("<", x, y, 0, "sort"));
        }
        return truthy((yield* interp.call(comparator, [x, y]))[0]);
      };
      // Insertion sort keeps the comparator call count predictable and is
      // plenty for the list sizes game scripts actually sort.
      for (let i = 1; i < values.length; i++) {
        const key = values[i];
        let j = i - 1;
        while (j >= 0 && (yield* compare(key, values[j]))) {
          values[j + 1] = values[j];
          j--;
        }
        values[j + 1] = key;
      }
      for (let i = 0; i < values.length; i++) t.set(i + 1, values[i]);
      return [];
    }),
  );
  g.set("table", tableLib);

  // -- math ---------------------------------------------------------------

  const mathLib = new LuaTable();
  const unary: Record<string, (n: number) => number> = {
    abs: Math.abs, ceil: Math.ceil, floor: Math.floor, sqrt: Math.sqrt,
    sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin,
    acos: Math.acos, atan: Math.atan, exp: Math.exp, sign: Math.sign,
    rad: (n) => (n * Math.PI) / 180, deg: (n) => (n * 180) / Math.PI,
  };
  for (const [name, fn] of Object.entries(unary)) {
    mathLib.set(name, nativeFn(name, (a) => [fn(checkNumber(a, 0, name))]));
  }
  mathLib.set(
    "log",
    nativeFn("log", (a) => {
      const x = checkNumber(a, 0, "log");
      return [a[1] === undefined ? Math.log(x) : Math.log(x) / Math.log(checkNumber(a, 1, "log"))];
    }),
  );
  mathLib.set("log10", nativeFn("log10", (a) => [Math.log10(checkNumber(a, 0, "log10"))]));
  mathLib.set(
    "atan2",
    nativeFn("atan2", (a) => [Math.atan2(checkNumber(a, 0, "atan2"), checkNumber(a, 1, "atan2"))]),
  );
  mathLib.set(
    "pow",
    nativeFn("pow", (a) => [Math.pow(checkNumber(a, 0, "pow"), checkNumber(a, 1, "pow"))]),
  );
  mathLib.set(
    "fmod",
    nativeFn("fmod", (a) => [checkNumber(a, 0, "fmod") % checkNumber(a, 1, "fmod")]),
  );
  mathLib.set(
    "modf",
    nativeFn("modf", (a) => {
      const n = checkNumber(a, 0, "modf");
      const int = n >= 0 ? Math.floor(n) : Math.ceil(n);
      return [int, n - int];
    }),
  );
  mathLib.set(
    "max",
    nativeFn("max", (a) => {
      if (a.length === 0) throw new LuaError("bad argument #1 to 'max' (number expected, got no value)");
      return [Math.max(...a.map((_, i) => checkNumber(a, i, "max")))];
    }),
  );
  mathLib.set(
    "min",
    nativeFn("min", (a) => {
      if (a.length === 0) throw new LuaError("bad argument #1 to 'min' (number expected, got no value)");
      return [Math.min(...a.map((_, i) => checkNumber(a, i, "min")))];
    }),
  );
  mathLib.set(
    "clamp",
    nativeFn("clamp", (a) => {
      const v = checkNumber(a, 0, "clamp");
      const lo = checkNumber(a, 1, "clamp");
      const hi = checkNumber(a, 2, "clamp");
      if (lo > hi) throw new LuaError("bad argument #3 to 'clamp' (max must be greater than min)");
      return [Math.min(Math.max(v, lo), hi)];
    }),
  );
  mathLib.set(
    "round",
    nativeFn("round", (a) => {
      const n = checkNumber(a, 0, "round");
      // Lua rounds halves away from zero, unlike Math.round.
      return [n >= 0 ? Math.round(n) : -Math.round(-n)];
    }),
  );
  mathLib.set("huge", Infinity);
  mathLib.set("pi", Math.PI);

  // Seedable so a server can reproduce a session exactly when debugging.
  let randomState = 0x2545f491;
  const nextRandom = (): number => {
    let x = randomState;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    randomState = x | 0;
    return (randomState >>> 0) / 4294967296;
  };
  mathLib.set(
    "randomseed",
    nativeFn("randomseed", (a) => {
      randomState = (checkNumber(a, 0, "randomseed") | 0) || 0x2545f491;
      return [];
    }),
  );
  mathLib.set(
    "random",
    nativeFn("random", (a) => {
      if (a.length === 0) return [nextRandom()];
      const lo = a.length === 1 ? 1 : checkNumber(a, 0, "random");
      const hi = a.length === 1 ? checkNumber(a, 0, "random") : checkNumber(a, 1, "random");
      if (lo > hi) throw new LuaError("bad argument #2 to 'random' (interval is empty)");
      return [lo + Math.floor(nextRandom() * (hi - lo + 1))];
    }),
  );
  g.set("math", mathLib);

  // -- os -----------------------------------------------------------------

  const osLib = new LuaTable();
  osLib.set("time", nativeFn("time", () => [Math.floor(Date.now() / 1000)]));
  osLib.set("clock", nativeFn("clock", () => [host.now()]));
  osLib.set(
    "date",
    nativeFn("date", (a) => {
      const format = a[0] === undefined ? "%c" : checkString(a, 0, "date");
      const time = a[1] === undefined ? Date.now() : checkNumber(a, 1, "date") * 1000;
      return [formatDate(format, new Date(time))];
    }),
  );
  g.set("os", osLib);

  // -- coroutine ----------------------------------------------------------

  const coroutineLib = new LuaTable();
  coroutineLib.set(
    "create",
    nativeFn("create", (a) => [new Coroutine(checkFunction(a, 0, "create"))]),
  );
  coroutineLib.set(
    "resume",
    yieldingFn("resume", function* (a) {
      const co = a[0];
      if (!isCoroutine(co)) throw new LuaError("bad argument #1 to 'resume' (coroutine expected)");
      const result = yield* interp.resume(co, a.slice(1));
      return [result.ok, ...result.values];
    }),
  );
  coroutineLib.set(
    "yield",
    yieldingFn("yield", function* (a) {
      // Suspends the current thread; the scheduler decides what comes back.
      const resumed = yield { kind: "yield", values: a };
      return resumed ?? [];
    }),
  );
  coroutineLib.set(
    "status",
    nativeFn("status", (a) => {
      const co = a[0];
      if (!isCoroutine(co)) throw new LuaError("bad argument #1 to 'status' (coroutine expected)");
      return [co.status];
    }),
  );
  coroutineLib.set(
    "isyieldable",
    nativeFn("isyieldable", () => [true]),
  );
  coroutineLib.set(
    "wrap",
    nativeFn("wrap", (a) => {
      const fn = checkFunction(a, 0, "wrap");
      const co = new Coroutine(fn);
      return [
        yieldingFn("wrapped", function* (callArgs) {
          const result = yield* interp.resume(co, callArgs);
          if (!result.ok) throw new LuaError(result.values[0]);
          return result.values;
        }),
      ];
    }),
  );
  coroutineLib.set(
    "close",
    nativeFn("close", (a) => {
      const co = a[0];
      if (!isCoroutine(co)) throw new LuaError("bad argument #1 to 'close' (coroutine expected)");
      co.status = "dead";
      return [true];
    }),
  );
  g.set("coroutine", coroutineLib);

  // -- task ---------------------------------------------------------------

  const taskLib = new LuaTable();
  const waitFn = yieldingFn("wait", function* (a) {
    const seconds = a[0] === undefined ? 0 : checkNumber(a, 0, "wait");
    const before = host.now();
    yield { kind: "wait", seconds: Math.max(0, seconds) };
    return [host.now() - before];
  });
  taskLib.set("wait", waitFn);
  taskLib.set(
    "spawn",
    nativeFn("spawn", (a) => {
      const fn = checkFunction(a, 0, "spawn");
      return [host.spawn(fn, a.slice(1), 0)];
    }),
  );
  taskLib.set(
    "defer",
    nativeFn("defer", (a) => {
      const fn = checkFunction(a, 0, "defer");
      return [host.spawn(fn, a.slice(1), 0, true)];
    }),
  );
  taskLib.set(
    "delay",
    nativeFn("delay", (a) => {
      const seconds = checkNumber(a, 0, "delay");
      const fn = checkFunction(a, 1, "delay");
      return [host.spawn(fn, a.slice(2), Math.max(0, seconds))];
    }),
  );
  taskLib.set(
    "cancel",
    nativeFn("cancel", (a) => {
      const co = a[0];
      if (!isCoroutine(co)) throw new LuaError("bad argument #1 to 'cancel' (coroutine expected)");
      host.cancel(co);
      return [];
    }),
  );
  g.set("task", taskLib);

  // Legacy Roblox globals, kept so ported scripts run unchanged.
  g.set("wait", waitFn);
  g.set("spawn", taskLib.get("spawn"));
  g.set("delay", taskLib.get("delay"));
  g.set("tick", nativeFn("tick", () => [Date.now() / 1000]));
  g.set("time", nativeFn("time", () => [host.now()]));
  g.set("elapsedTime", nativeFn("elapsedTime", () => [host.now()]));
}

/** string.format, covering the specifiers Lua supports. */
function luaFormat(args: LuaValue[]): string {
  const format = typeof args[0] === "string" ? args[0] : tostring(args[0]);
  let argIndex = 1;
  let out = "";
  let i = 0;

  while (i < format.length) {
    const c = format[i++];
    if (c !== "%") {
      out += c;
      continue;
    }
    if (format[i] === "%") {
      out += "%";
      i++;
      continue;
    }
    // flags, width and precision
    let spec = "";
    while ("-+ #0".includes(format[i])) spec += format[i++];
    let width = "";
    while (/[0-9]/.test(format[i])) width += format[i++];
    let precision = "";
    if (format[i] === ".") {
      i++;
      precision = "";
      while (/[0-9]/.test(format[i])) precision += format[i++];
      if (precision === "") precision = "0";
    }
    const conv = format[i++];
    const value = args[argIndex++];

    let text: string;
    switch (conv) {
      case "d": case "i": {
        const n = tonumber(value);
        if (n === undefined) throw new LuaError(`bad argument #${argIndex - 1} to 'format' (number expected)`);
        text = String(Math.trunc(n));
        if (spec.includes("+") && n >= 0) text = `+${text}`;
        break;
      }
      case "u": text = String(Math.abs(Math.trunc(Number(tonumber(value) ?? 0)))); break;
      case "c": text = String.fromCharCode(Number(tonumber(value) ?? 0)); break;
      case "x": text = (Math.trunc(Number(tonumber(value) ?? 0)) >>> 0).toString(16); break;
      case "X": text = (Math.trunc(Number(tonumber(value) ?? 0)) >>> 0).toString(16).toUpperCase(); break;
      case "o": text = (Math.trunc(Number(tonumber(value) ?? 0)) >>> 0).toString(8); break;
      case "f": case "F": {
        const n = tonumber(value);
        if (n === undefined) throw new LuaError(`bad argument #${argIndex - 1} to 'format' (number expected)`);
        text = n.toFixed(precision === "" ? 6 : Number(precision));
        if (spec.includes("+") && n >= 0) text = `+${text}`;
        break;
      }
      case "e": case "E": {
        const n = Number(tonumber(value) ?? 0);
        text = n.toExponential(precision === "" ? 6 : Number(precision));
        if (conv === "E") text = text.toUpperCase();
        break;
      }
      case "g": case "G": {
        const n = Number(tonumber(value) ?? 0);
        const p = precision === "" ? 6 : Math.max(Number(precision), 1);
        text = String(Number(n.toPrecision(p)));
        if (conv === "G") text = text.toUpperCase();
        break;
      }
      case "s": {
        text = tostring(value);
        if (precision !== "") text = text.slice(0, Number(precision));
        break;
      }
      case "q": text = JSON.stringify(tostring(value)); break;
      case "*": text = tostring(value); break;
      default:
        throw new LuaError(`invalid conversion '%${conv ?? ""}' to 'format'`);
    }

    if (width !== "") {
      const w = Number(width);
      if (text.length < w) {
        if (spec.includes("-")) text = text.padEnd(w);
        else if (spec.includes("0") && "dieEfgGxXou".includes(conv)) {
          const negative = text.startsWith("-") || text.startsWith("+");
          text = negative
            ? text[0] + text.slice(1).padStart(w - 1, "0")
            : text.padStart(w, "0");
        } else text = text.padStart(w);
      }
    }
    out += text;
  }
  return out;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatDate(format: string, date: Date): string {
  const utc = format.startsWith("!");
  const f = utc ? format.slice(1) : format;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const get = {
    Y: utc ? date.getUTCFullYear() : date.getFullYear(),
    m: (utc ? date.getUTCMonth() : date.getMonth()) + 1,
    d: utc ? date.getUTCDate() : date.getDate(),
    H: utc ? date.getUTCHours() : date.getHours(),
    M: utc ? date.getUTCMinutes() : date.getMinutes(),
    S: utc ? date.getUTCSeconds() : date.getSeconds(),
    w: utc ? date.getUTCDay() : date.getDay(),
  };
  if (f === "*t" || f === "!*t") return String(date.getTime());
  return f.replace(/%(.)/g, (_, spec: string) => {
    switch (spec) {
      case "Y": return String(get.Y);
      case "y": return pad(get.Y % 100);
      case "m": return pad(get.m);
      case "d": return pad(get.d);
      case "H": return pad(get.H);
      case "M": return pad(get.M);
      case "S": return pad(get.S);
      case "p": return get.H < 12 ? "AM" : "PM";
      case "A": return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][get.w];
      case "a": return DAYS[get.w];
      case "B": return ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][get.m - 1];
      case "b": return MONTHS[get.m - 1];
      case "c": return `${DAYS[get.w]} ${MONTHS[get.m - 1]} ${pad(get.d)} ${pad(get.H)}:${pad(get.M)}:${pad(get.S)} ${get.Y}`;
      case "x": return `${pad(get.m)}/${pad(get.d)}/${pad(get.Y % 100)}`;
      case "X": return `${pad(get.H)}:${pad(get.M)}:${pad(get.S)}`;
      case "%": return "%";
      default: return `%${spec}`;
    }
  });
}
