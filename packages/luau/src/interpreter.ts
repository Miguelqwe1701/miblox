import type { Block, Expr, Stat } from "./ast.js";
import { parse } from "./parser.js";
import {
  Coroutine,
  LuaError,
  LuaTable,
  type LuaFunction,
  type LuaValue,
  type YieldRequest,
  arithNumber,
  getMetamethod,
  isFunction,
  isUserdata,
  luaType,
  numberToString,
  rawEquals,
  tostring,
  truthy,
} from "./values.js";

/** Variable box, so closures capture by reference as Lua upvalues do. */
interface Box {
  v: LuaValue;
}

export class Scope {
  private vars = new Map<string, Box>();

  constructor(
    readonly parent: Scope | null = null,
    /** Varargs visible to this function body, if it is one. */
    readonly varargs: LuaValue[] | null = null,
  ) {}

  declare(name: string, value: LuaValue): Box {
    const box: Box = { v: value };
    this.vars.set(name, box);
    return box;
  }

  lookup(name: string): Box | undefined {
    let scope: Scope | null = this;
    while (scope) {
      const box = scope.vars.get(name);
      if (box) return box;
      scope = scope.parent;
    }
    return undefined;
  }

  /** Nearest enclosing function's varargs. */
  findVarargs(): LuaValue[] {
    let scope: Scope | null = this;
    while (scope) {
      if (scope.varargs) return scope.varargs;
      scope = scope.parent;
    }
    return [];
  }
}

interface Proto {
  params: string[];
  isVararg: boolean;
  body: Block;
  name: string;
  line: number;
  chunkName: string;
}

/** Non-local control flow escaping a block. */
type Flow =
  | { type: "normal" }
  | { type: "return"; values: LuaValue[] }
  | { type: "break" }
  | { type: "continue" };

const NORMAL: Flow = { type: "normal" };

export interface InterpreterOptions {
  globals?: LuaTable;
  /** Aborts a script that never yields, so one bad loop cannot hang the server. */
  maxSteps?: number;
  /** Receives `print` output; defaults to console.log. */
  onPrint?: (text: string) => void;
  onWarn?: (text: string) => void;
}

export interface CallFrame {
  name: string;
  line: number;
  chunkName: string;
}

/**
 * Tree-walking Luau interpreter.
 *
 * Every evaluation step is a generator, which is what makes `coroutine.yield`
 * and `task.wait` work: a suspended script is simply a paused generator, so the
 * scheduler can resume it on a later frame without threads or callbacks.
 */
export class Interpreter {
  readonly globals: LuaTable;
  readonly callStack: CallFrame[] = [];
  maxSteps: number;
  private steps = 0;
  onPrint: (text: string) => void;
  onWarn: (text: string) => void;

  constructor(opts: InterpreterOptions = {}) {
    this.globals = opts.globals ?? new LuaTable();
    this.maxSteps = opts.maxSteps ?? 5_000_000;
    this.onPrint = opts.onPrint ?? ((t) => console.log(t));
    this.onWarn = opts.onWarn ?? ((t) => console.warn(t));
  }

  /** Reset per resume, so the budget is per slice rather than per lifetime. */
  resetSteps(): void {
    this.steps = 0;
  }

  private tick(line: number): void {
    if (++this.steps > this.maxSteps) {
      this.steps = 0;
      throw new LuaError(
        `script exceeded ${this.maxSteps} instructions without yielding (line ${line}) ` +
          `- add a task.wait() inside long loops`,
      );
    }
  }

  /** Compiles source into a callable chunk. Syntax errors throw here. */
  load(source: string, chunkName = "chunk", env?: Scope): LuaFunction {
    const body = parse(source, chunkName);
    const proto: Proto = {
      params: [],
      isVararg: true,
      body,
      name: chunkName,
      line: 1,
      chunkName,
    };
    return this.makeClosure(proto, env ?? new Scope(null, []));
  }

  private makeClosure(proto: Proto, scope: Scope): LuaFunction {
    return { __luafunction: true, name: proto.name, proto, upvalues: scope };
  }

  traceback(): string {
    return this.callStack
      .slice()
      .reverse()
      .map((f) => `    ${f.chunkName}:${f.line}: in ${f.name}`)
      .join("\n");
  }

  private throwLua(message: string, line: number, chunkName = "chunk"): never {
    throw new LuaError(`${chunkName}:${line}: ${message}`, this.traceback());
  }

  // -- calling -------------------------------------------------------------

  *call(fn: LuaValue, args: LuaValue[], line = 0): Generator<YieldRequest, LuaValue[], LuaValue[]> {
    if (!isFunction(fn)) {
      const meta = getMetamethod(fn, "__call");
      if (isFunction(meta)) return yield* this.call(meta, [fn, ...args], line);
      this.throwLua(`attempt to call a ${luaType(fn)} value`, line);
    }
    if (fn.native) return fn.native(args) ?? [];
    if (fn.nativeGen) return yield* fn.nativeGen(args);

    const proto = fn.proto as Proto;
    if (this.callStack.length > 200) {
      this.throwLua("stack overflow", proto.line, proto.chunkName);
    }
    const scope = new Scope(
      fn.upvalues as Scope,
      proto.isVararg ? args.slice(proto.params.length) : [],
    );
    for (let i = 0; i < proto.params.length; i++) {
      scope.declare(proto.params[i], args[i]);
    }
    this.callStack.push({ name: proto.name, line: proto.line, chunkName: proto.chunkName });
    try {
      const flow = yield* this.execBlock(proto.body, scope, proto.chunkName);
      return flow.type === "return" ? flow.values : [];
    } finally {
      this.callStack.pop();
    }
  }

  /** Runs a function to completion, refusing to yield. For top-level hosts. */
  callSync(fn: LuaValue, args: LuaValue[] = []): LuaValue[] {
    const gen = this.call(fn, args);
    const step = gen.next();
    if (!step.done) {
      throw new LuaError("attempt to yield from a context that cannot yield");
    }
    return step.value;
  }

  // -- statements ----------------------------------------------------------

  *execBlock(
    block: Block,
    scope: Scope,
    chunkName: string,
  ): Generator<YieldRequest, Flow, LuaValue[]> {
    for (const stat of block.stats) {
      const flow = yield* this.execStat(stat, scope, chunkName);
      if (flow.type !== "normal") return flow;
    }
    return NORMAL;
  }

  private *execStat(
    stat: Stat,
    scope: Scope,
    chunkName: string,
  ): Generator<YieldRequest, Flow, LuaValue[]> {
    this.tick(stat.line);
    const frame = this.callStack[this.callStack.length - 1];
    if (frame) frame.line = stat.line;

    switch (stat.kind) {
      case "Local": {
        const values = yield* this.evalExprList(stat.values, scope, chunkName);
        for (let i = 0; i < stat.names.length; i++) {
          scope.declare(stat.names[i], values[i]);
        }
        return NORMAL;
      }

      case "Assign": {
        const values = yield* this.evalExprList(stat.values, scope, chunkName);
        for (let i = 0; i < stat.targets.length; i++) {
          yield* this.assign(stat.targets[i], values[i], scope, chunkName);
        }
        return NORMAL;
      }

      case "CompoundAssign": {
        const current = yield* this.evalExpr(stat.target, scope, chunkName);
        const operand = yield* this.evalExpr(stat.value, scope, chunkName);
        const result = yield* this.binaryOp(stat.op, current, operand, stat.line, chunkName);
        yield* this.assign(stat.target, result, scope, chunkName);
        return NORMAL;
      }

      case "ExprStat":
        yield* this.evalMulti(stat.expr, scope, chunkName);
        return NORMAL;

      case "Do":
        return yield* this.execBlock(stat.body, new Scope(scope), chunkName);

      case "If": {
        for (const clause of stat.clauses) {
          const cond = yield* this.evalExpr(clause.cond, scope, chunkName);
          if (truthy(cond)) {
            return yield* this.execBlock(clause.body, new Scope(scope), chunkName);
          }
        }
        if (stat.orelse) return yield* this.execBlock(stat.orelse, new Scope(scope), chunkName);
        return NORMAL;
      }

      case "While": {
        for (;;) {
          this.tick(stat.line);
          const cond = yield* this.evalExpr(stat.cond, scope, chunkName);
          if (!truthy(cond)) break;
          const flow = yield* this.execBlock(stat.body, new Scope(scope), chunkName);
          if (flow.type === "break") break;
          if (flow.type === "return") return flow;
        }
        return NORMAL;
      }

      case "Repeat": {
        for (;;) {
          this.tick(stat.line);
          // The condition can see locals from the body, so they share a scope.
          const bodyScope = new Scope(scope);
          const flow = yield* this.execBlock(stat.body, bodyScope, chunkName);
          if (flow.type === "break") break;
          if (flow.type === "return") return flow;
          const cond = yield* this.evalExpr(stat.cond, bodyScope, chunkName);
          if (truthy(cond)) break;
        }
        return NORMAL;
      }

      case "NumericFor": {
        const start = this.toNumber(
          yield* this.evalExpr(stat.start, scope, chunkName),
          "'for' initial value",
          stat.line,
          chunkName,
        );
        const limit = this.toNumber(
          yield* this.evalExpr(stat.limit, scope, chunkName),
          "'for' limit",
          stat.line,
          chunkName,
        );
        const step = stat.step
          ? this.toNumber(
              yield* this.evalExpr(stat.step, scope, chunkName),
              "'for' step",
              stat.line,
              chunkName,
            )
          : 1;
        if (step === 0) this.throwLua("'for' step is zero", stat.line, chunkName);

        for (let i = start; step > 0 ? i <= limit : i >= limit; i += step) {
          this.tick(stat.line);
          const iterScope = new Scope(scope);
          iterScope.declare(stat.name, i);
          const flow = yield* this.execBlock(stat.body, iterScope, chunkName);
          if (flow.type === "break") break;
          if (flow.type === "return") return flow;
        }
        return NORMAL;
      }

      case "GenericFor": {
        let [iterator, state, control] = yield* this.evalExprList(stat.exprs, scope, chunkName);
        // Luau lets you iterate a table directly; __iter or pairs fills in.
        if (!isFunction(iterator)) {
          const iterMeta = getMetamethod(iterator, "__iter");
          if (isFunction(iterMeta)) {
            [iterator, state, control] = yield* this.call(iterMeta, [iterator], stat.line);
          } else if (iterator instanceof LuaTable) {
            const pairsFn = this.globals.get("pairs");
            if (isFunction(pairsFn)) {
              [iterator, state, control] = yield* this.call(pairsFn, [iterator], stat.line);
            }
          }
        }
        if (!isFunction(iterator)) {
          this.throwLua(`attempt to iterate over a ${luaType(iterator)} value`, stat.line, chunkName);
        }
        for (;;) {
          this.tick(stat.line);
          const results = yield* this.call(iterator, [state, control], stat.line);
          if (results[0] === undefined) break;
          control = results[0];
          const iterScope = new Scope(scope);
          for (let i = 0; i < stat.names.length; i++) {
            iterScope.declare(stat.names[i], results[i]);
          }
          const flow = yield* this.execBlock(stat.body, iterScope, chunkName);
          if (flow.type === "break") break;
          if (flow.type === "return") return flow;
        }
        return NORMAL;
      }

      case "Return":
        return { type: "return", values: yield* this.evalExprList(stat.values, scope, chunkName) };

      case "Break":
        return { type: "break" };

      case "Continue":
        return { type: "continue" };

      case "LocalFunction": {
        // Declared before the body is evaluated, so the function can recurse.
        const box = scope.declare(stat.name, undefined);
        box.v = yield* this.evalExpr(stat.fn, scope, chunkName);
        return NORMAL;
      }

      case "FunctionDecl": {
        const fn = yield* this.evalExpr(stat.fn, scope, chunkName);
        yield* this.assign(stat.target, fn, scope, chunkName);
        return NORMAL;
      }

      case "TypeAlias":
        return NORMAL; // Types are erased at runtime.
    }
  }

  private toNumber(v: LuaValue, what: string, line: number, chunkName: string): number {
    if (typeof v === "number") return v;
    if (typeof v === "string") {
      const n = Number(v);
      if (!Number.isNaN(n)) return n;
    }
    this.throwLua(`${what} must be a number`, line, chunkName);
  }

  private *assign(
    target: Expr,
    value: LuaValue,
    scope: Scope,
    chunkName: string,
  ): Generator<YieldRequest, void, LuaValue[]> {
    if (target.kind === "Name") {
      const box = scope.lookup(target.name);
      if (box) box.v = value;
      else this.globals.set(target.name, value);
      return;
    }
    if (target.kind === "Index") {
      const object = yield* this.evalExpr(target.object, scope, chunkName);
      const key = yield* this.evalExpr(target.index, scope, chunkName);
      yield* this.setIndex(object, key, value, target.line, chunkName);
      return;
    }
    this.throwLua("cannot assign to this expression", target.line, chunkName);
  }

  // -- expressions ---------------------------------------------------------

  /** Evaluates to exactly one value, truncating multiple returns. */
  *evalExpr(
    expr: Expr,
    scope: Scope,
    chunkName: string,
  ): Generator<YieldRequest, LuaValue, LuaValue[]> {
    this.tick(expr.line);
    switch (expr.kind) {
      case "Nil": return undefined;
      case "True": return true;
      case "False": return false;
      case "Number": return expr.value;
      case "String": return expr.value;

      case "Vararg": return scope.findVarargs()[0];

      case "Paren": {
        const values = yield* this.evalMulti(expr.expr, scope, chunkName);
        return values[0];
      }

      case "Name": {
        const box = scope.lookup(expr.name);
        return box ? box.v : this.globals.get(expr.name);
      }

      case "Index": {
        const object = yield* this.evalExpr(expr.object, scope, chunkName);
        const key = yield* this.evalExpr(expr.index, scope, chunkName);
        return yield* this.index(object, key, expr.line, chunkName, expr.object);
      }

      case "Call":
      case "MethodCall": {
        const values = yield* this.evalMulti(expr, scope, chunkName);
        return values[0];
      }

      case "Function": {
        const proto: Proto = {
          params: expr.params,
          isVararg: expr.isVararg,
          body: expr.body,
          name: expr.name,
          line: expr.line,
          chunkName,
        };
        return this.makeClosure(proto, scope);
      }

      case "Table": {
        const table = new LuaTable();
        let arrayIndex = 1;
        for (let i = 0; i < expr.entries.length; i++) {
          const entry = expr.entries[i];
          if (entry.type === "record") {
            const key = yield* this.evalExpr(entry.key, scope, chunkName);
            const value = yield* this.evalExpr(entry.value, scope, chunkName);
            table.set(key, value);
            continue;
          }
          const isLast = i === expr.entries.length - 1;
          if (isLast && isMultiValue(entry.value)) {
            // A trailing call or `...` expands into the array part.
            const values = yield* this.evalMulti(entry.value, scope, chunkName);
            for (const value of values) table.set(arrayIndex++, value);
            continue;
          }
          table.set(arrayIndex++, yield* this.evalExpr(entry.value, scope, chunkName));
        }
        return table;
      }

      case "Binary": {
        if (expr.op === "and") {
          const left = yield* this.evalExpr(expr.left, scope, chunkName);
          return truthy(left) ? yield* this.evalExpr(expr.right, scope, chunkName) : left;
        }
        if (expr.op === "or") {
          const left = yield* this.evalExpr(expr.left, scope, chunkName);
          return truthy(left) ? left : yield* this.evalExpr(expr.right, scope, chunkName);
        }
        const left = yield* this.evalExpr(expr.left, scope, chunkName);
        const right = yield* this.evalExpr(expr.right, scope, chunkName);
        return yield* this.binaryOp(expr.op, left, right, expr.line, chunkName);
      }

      case "Unary": {
        const operand = yield* this.evalExpr(expr.operand, scope, chunkName);
        return yield* this.unaryOp(expr.op, operand, expr.line, chunkName);
      }

      case "Interp": {
        let out = "";
        for (const part of expr.parts) {
          if (typeof part === "string") {
            out += part;
            continue;
          }
          const value = yield* this.evalExpr(part, scope, chunkName);
          out += yield* this.tostringMeta(value, expr.line);
        }
        return out;
      }

      case "IfElseExpr": {
        const cond = yield* this.evalExpr(expr.cond, scope, chunkName);
        return truthy(cond)
          ? yield* this.evalExpr(expr.then, scope, chunkName)
          : yield* this.evalExpr(expr.else, scope, chunkName);
      }
    }
  }

  /** Evaluates an expression that may produce several values. */
  *evalMulti(
    expr: Expr,
    scope: Scope,
    chunkName: string,
  ): Generator<YieldRequest, LuaValue[], LuaValue[]> {
    switch (expr.kind) {
      case "Call": {
        const callee = yield* this.evalExpr(expr.callee, scope, chunkName);
        const args = yield* this.evalExprList(expr.args, scope, chunkName);
        if (!isFunction(callee) && getMetamethod(callee, "__call") === undefined) {
          this.throwLua(
            `attempt to call a ${luaType(callee)} value${describeCallee(expr.callee)}`,
            expr.line,
            chunkName,
          );
        }
        return yield* this.call(callee, args, expr.line);
      }
      case "MethodCall": {
        const object = yield* this.evalExpr(expr.object, scope, chunkName);
        const method = yield* this.index(object, expr.method, expr.line, chunkName, expr.object);
        const args = yield* this.evalExprList(expr.args, scope, chunkName);
        if (!isFunction(method) && getMetamethod(method, "__call") === undefined) {
          this.throwLua(
            `attempt to call method '${expr.method}' (a ${luaType(method)} value)`,
            expr.line,
            chunkName,
          );
        }
        return yield* this.call(method, [object, ...args], expr.line);
      }
      case "Vararg":
        return scope.findVarargs().slice();
      default:
        return [yield* this.evalExpr(expr, scope, chunkName)];
    }
  }

  /** Evaluates a list where only the final expression expands. */
  private *evalExprList(
    exprs: Expr[],
    scope: Scope,
    chunkName: string,
  ): Generator<YieldRequest, LuaValue[], LuaValue[]> {
    const out: LuaValue[] = [];
    for (let i = 0; i < exprs.length; i++) {
      if (i === exprs.length - 1 && isMultiValue(exprs[i])) {
        out.push(...(yield* this.evalMulti(exprs[i], scope, chunkName)));
      } else {
        out.push(yield* this.evalExpr(exprs[i], scope, chunkName));
      }
    }
    return out;
  }

  // -- indexing ------------------------------------------------------------

  *index(
    object: LuaValue,
    key: LuaValue,
    line: number,
    chunkName: string,
    sourceExpr?: Expr,
  ): Generator<YieldRequest, LuaValue, LuaValue[]> {
    let current = object;
    for (let depth = 0; depth < 100; depth++) {
      if (current instanceof LuaTable) {
        const raw = current.get(key);
        if (raw !== undefined) return raw;
        const meta = current.metatable?.get("__index");
        if (meta === undefined) return undefined;
        if (isFunction(meta)) return (yield* this.call(meta, [current, key], line))[0];
        current = meta;
        continue;
      }
      const meta = getMetamethod(current, "__index");
      if (meta === undefined) {
        this.throwLua(
          `attempt to index a ${luaType(current)} value${describeIndex(sourceExpr, key)}`,
          line,
          chunkName,
        );
      }
      if (isFunction(meta)) return (yield* this.call(meta, [current, key], line))[0];
      current = meta;
    }
    this.throwLua("'__index' chain too long; possible loop", line, chunkName);
  }

  *setIndex(
    object: LuaValue,
    key: LuaValue,
    value: LuaValue,
    line: number,
    chunkName: string,
  ): Generator<YieldRequest, void, LuaValue[]> {
    let current = object;
    for (let depth = 0; depth < 100; depth++) {
      if (current instanceof LuaTable) {
        if (current.get(key) !== undefined || current.metatable === undefined) {
          current.set(key, value);
          return;
        }
        const meta = current.metatable.get("__newindex");
        if (meta === undefined) {
          current.set(key, value);
          return;
        }
        if (isFunction(meta)) {
          yield* this.call(meta, [current, key, value], line);
          return;
        }
        current = meta;
        continue;
      }
      const meta = getMetamethod(current, "__newindex");
      if (meta === undefined) {
        this.throwLua(`attempt to index a ${luaType(current)} value`, line, chunkName);
      }
      if (isFunction(meta)) {
        yield* this.call(meta, [current, key, value], line);
        return;
      }
      current = meta;
    }
    this.throwLua("'__newindex' chain too long; possible loop", line, chunkName);
  }

  // -- operators -----------------------------------------------------------

  *tostringMeta(value: LuaValue, line: number): Generator<YieldRequest, string, LuaValue[]> {
    const meta = getMetamethod(value, "__tostring");
    if (isFunction(meta)) {
      const result = yield* this.call(meta, [value], line);
      return tostring(result[0]);
    }
    return tostring(value);
  }

  private *metaBinary(
    event: string,
    a: LuaValue,
    b: LuaValue,
    line: number,
  ): Generator<YieldRequest, { ok: boolean; value: LuaValue }, LuaValue[]> {
    const handler = getMetamethod(a, event) ?? getMetamethod(b, event);
    if (!isFunction(handler)) return { ok: false, value: undefined };
    const result = yield* this.call(handler, [a, b], line);
    return { ok: true, value: result[0] };
  }

  *binaryOp(
    op: string,
    a: LuaValue,
    b: LuaValue,
    line: number,
    chunkName: string,
  ): Generator<YieldRequest, LuaValue, LuaValue[]> {
    switch (op) {
      case "+": case "-": case "*": case "/": case "//": case "%": case "^": {
        if (typeof a === "number" && typeof b === "number") return rawArith(op, a, b);
        const event = ARITH_EVENTS[op];
        const meta = yield* this.metaBinary(event, a, b, line);
        if (meta.ok) return meta.value;
        // No metamethod, so fall back to string coercion, which may throw.
        const which = typeof a === "number" || typeof a === "string" ? b : a;
        if (typeof which !== "number" && typeof which !== "string") {
          this.throwLua(
            `attempt to perform arithmetic (${op}) on a ${luaType(which)} value`,
            line,
            chunkName,
          );
        }
        return rawArith(op, arithNumber(a, op), arithNumber(b, op));
      }

      case "..": {
        const aOk = typeof a === "string" || typeof a === "number";
        const bOk = typeof b === "string" || typeof b === "number";
        if (aOk && bOk) return concat(a) + concat(b);
        const meta = yield* this.metaBinary("__concat", a, b, line);
        if (meta.ok) return meta.value;
        this.throwLua(
          `attempt to concatenate a ${luaType(aOk ? b : a)} value`,
          line,
          chunkName,
        );
      }

      case "==": return yield* this.equals(a, b, line);
      case "~=": return !(yield* this.equals(a, b, line));

      case "<": return yield* this.lessThan(a, b, line, chunkName);
      case ">": return yield* this.lessThan(b, a, line, chunkName);
      case "<=": return yield* this.lessEqual(a, b, line, chunkName);
      case ">=": return yield* this.lessEqual(b, a, line, chunkName);
    }
    this.throwLua(`unknown binary operator '${op}'`, line, chunkName);
  }

  private *equals(a: LuaValue, b: LuaValue, line: number): Generator<YieldRequest, boolean, LuaValue[]> {
    if (rawEquals(a, b)) return true;
    // __eq only applies when both sides are the same non-primitive kind.
    const bothTables = a instanceof LuaTable && b instanceof LuaTable;
    const bothUserdata = isUserdata(a) && isUserdata(b);
    if (!bothTables && !bothUserdata) return false;
    const meta = yield* this.metaBinary("__eq", a, b, line);
    return meta.ok ? truthy(meta.value) : false;
  }

  private *lessThan(
    a: LuaValue,
    b: LuaValue,
    line: number,
    chunkName: string,
  ): Generator<YieldRequest, boolean, LuaValue[]> {
    if (typeof a === "number" && typeof b === "number") return a < b;
    if (typeof a === "string" && typeof b === "string") return a < b;
    const meta = yield* this.metaBinary("__lt", a, b, line);
    if (meta.ok) return truthy(meta.value);
    this.throwLua(`attempt to compare ${luaType(a)} with ${luaType(b)}`, line, chunkName);
  }

  private *lessEqual(
    a: LuaValue,
    b: LuaValue,
    line: number,
    chunkName: string,
  ): Generator<YieldRequest, boolean, LuaValue[]> {
    if (typeof a === "number" && typeof b === "number") return a <= b;
    if (typeof a === "string" && typeof b === "string") return a <= b;
    const meta = yield* this.metaBinary("__le", a, b, line);
    if (meta.ok) return truthy(meta.value);
    // Lua 5.1 falls back to `not (b < a)` when __le is missing.
    const lt = yield* this.metaBinary("__lt", b, a, line);
    if (lt.ok) return !truthy(lt.value);
    this.throwLua(`attempt to compare ${luaType(a)} with ${luaType(b)}`, line, chunkName);
  }

  *unaryOp(
    op: string,
    v: LuaValue,
    line: number,
    chunkName: string,
  ): Generator<YieldRequest, LuaValue, LuaValue[]> {
    switch (op) {
      case "-": {
        if (typeof v === "number") return -v;
        const handler = getMetamethod(v, "__unm");
        if (isFunction(handler)) return (yield* this.call(handler, [v, v], line))[0];
        if (typeof v === "string") return -arithNumber(v, "-");
        this.throwLua(`attempt to perform arithmetic (-) on a ${luaType(v)} value`, line, chunkName);
      }
      case "not":
        return !truthy(v);
      case "#": {
        if (typeof v === "string") return v.length;
        const handler = getMetamethod(v, "__len");
        if (isFunction(handler)) return (yield* this.call(handler, [v], line))[0];
        if (v instanceof LuaTable) return v.length;
        this.throwLua(`attempt to get length of a ${luaType(v)} value`, line, chunkName);
      }
    }
    this.throwLua(`unknown unary operator '${op}'`, line, chunkName);
  }

  // -- coroutines ----------------------------------------------------------

  /** Resumes a coroutine, returning either its yield or its final values. */
  *resume(
    co: Coroutine,
    args: LuaValue[],
  ): Generator<YieldRequest, { ok: boolean; values: LuaValue[] }, LuaValue[]> {
    if (co.status === "dead") {
      return { ok: false, values: ["cannot resume dead coroutine"] };
    }
    if (co.status === "running") {
      return { ok: false, values: ["cannot resume non-suspended coroutine"] };
    }
    if (!co.gen) co.gen = this.call(co.fn, args);
    co.status = "running";
    try {
      const step = co.gen.next(args);
      if (step.done) {
        co.status = "dead";
        return { ok: true, values: step.value };
      }
      const request = step.value;
      if (request.kind === "yield") {
        co.status = "suspended";
        return { ok: true, values: request.values };
      }
      // Anything else (task.wait, a promise) belongs to the scheduler, so pass
      // it outward and let the resumption flow back in.
      co.status = "suspended";
      const resumed = yield request;
      co.status = "normal";
      return yield* this.resumeWith(co, resumed);
    } catch (err) {
      co.status = "dead";
      const value = err instanceof LuaError ? err.value : String(err);
      co.error = err instanceof LuaError ? err : new LuaError(String(err));
      return { ok: false, values: [value] };
    }
  }

  private *resumeWith(
    co: Coroutine,
    values: LuaValue[],
  ): Generator<YieldRequest, { ok: boolean; values: LuaValue[] }, LuaValue[]> {
    co.status = "suspended";
    return yield* this.resume(co, values);
  }
}

const ARITH_EVENTS: Record<string, string> = {
  "+": "__add",
  "-": "__sub",
  "*": "__mul",
  "/": "__div",
  "//": "__idiv",
  "%": "__mod",
  "^": "__pow",
};

function rawArith(op: string, a: number, b: number): number {
  switch (op) {
    case "+": return a + b;
    case "-": return a - b;
    case "*": return a * b;
    case "/": return a / b;
    case "//": return Math.floor(a / b);
    // Lua's % follows the sign of the divisor, unlike JS's remainder.
    case "%": return a - Math.floor(a / b) * b;
    case "^": return Math.pow(a, b);
  }
  return NaN;
}

function concat(v: string | number): string {
  return typeof v === "number" ? numberToString(v) : v;
}

function isMultiValue(expr: Expr): boolean {
  return expr.kind === "Call" || expr.kind === "MethodCall" || expr.kind === "Vararg";
}

function describeCallee(expr: Expr): string {
  if (expr.kind === "Name") return ` (global '${expr.name}')`;
  if (expr.kind === "Index" && expr.index.kind === "String") {
    return ` (field '${expr.index.value}')`;
  }
  return "";
}

function describeIndex(sourceExpr: Expr | undefined, key: LuaValue): string {
  if (sourceExpr?.kind === "Name") return ` (global '${sourceExpr.name}')`;
  if (typeof key === "string") return ` (field '${key}')`;
  return "";
}
