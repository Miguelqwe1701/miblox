import { test } from "node:test";
import assert from "node:assert/strict";
import { LuauVM, LuaTable, LuauSyntaxError } from "../dist/index.js";

/** Evaluates a chunk and returns its first return value. */
function evalOne(source) {
  return new LuauVM().eval(`return ${source}`)[0];
}

/** Runs a full chunk, returning everything it returned. */
function run(source) {
  return new LuauVM().eval(source);
}

/** Runs a chunk and collects everything it printed. */
function collectPrints(source) {
  const vm = new LuauVM();
  const lines = [];
  vm.onPrint = (t) => lines.push(t);
  vm.eval(source);
  return lines;
}

test("arithmetic and precedence", () => {
  assert.equal(evalOne("1 + 2 * 3"), 7);
  assert.equal(evalOne("(1 + 2) * 3"), 9);
  assert.equal(evalOne("2 ^ 3 ^ 2"), 512, "^ is right associative");
  assert.equal(evalOne("-2 ^ 2"), -4, "^ binds tighter than unary minus");
  assert.equal(evalOne("7 // 2"), 3);
  assert.equal(evalOne("7 % 3"), 1);
  assert.equal(evalOne("-7 % 3"), 2, "Lua's % follows the divisor's sign");
  assert.equal(evalOne("10 / 4"), 2.5);
});

test("comparison and logic", () => {
  assert.equal(evalOne("1 < 2"), true);
  assert.equal(evalOne('"a" < "b"'), true);
  assert.equal(evalOne("1 ~= 2"), true);
  assert.equal(evalOne("nil or 5"), 5);
  assert.equal(evalOne("false or nil"), undefined);
  assert.equal(evalOne("0 and 1"), 1, "0 is truthy in Lua");
  assert.equal(evalOne('"" and 1'), 1, "the empty string is truthy in Lua");
  assert.equal(evalOne("nil and error('never runs')"), undefined);
});

test("string concatenation coerces numbers", () => {
  assert.equal(evalOne('"x" .. 1'), "x1");
  assert.equal(evalOne("1 .. 2"), "12");
  assert.equal(evalOne('"a" .. "b" .. "c"'), "abc");
});

test("length operator", () => {
  assert.equal(evalOne('#"hello"'), 5);
  assert.equal(evalOne("#{1, 2, 3}"), 3);
  assert.equal(evalOne("#{}"), 0);
});

test("locals, scoping and shadowing", () => {
  assert.equal(
    run(`
      local x = 1
      do local x = 2 end
      return x
    `)[0],
    1,
  );
});

test("closures capture by reference", () => {
  const [get, set] = run(`
    local count = 0
    local function inc() count = count + 1 return count end
    return inc(), inc()
  `);
  assert.equal(get, 1);
  assert.equal(set, 2);
});

test("each loop iteration gets a fresh binding", () => {
  assert.deepEqual(
    run(`
      local fns = {}
      for i = 1, 3 do fns[i] = function() return i end end
      return fns[1](), fns[2](), fns[3]()
    `),
    [1, 2, 3],
  );
});

test("multiple returns and assignment", () => {
  assert.deepEqual(
    run(`
      local function two() return 1, 2 end
      local a, b, c = two()
      return a, b, c
    `),
    [1, 2, undefined],
  );
});

test("parentheses truncate multiple returns", () => {
  assert.deepEqual(
    run(`
      local function two() return 1, 2 end
      return (two())
    `),
    [1],
  );
});

test("parentheses around a call returning false keep the false", () => {
  // A naive `(x) -> x or nil` desugaring would turn this into nil.
  assert.deepEqual(
    run(`
      local function f() return false, "second" end
      return (f())
    `),
    [false],
  );
});

test("varargs", () => {
  assert.deepEqual(
    run(`
      local function f(...) return select("#", ...), ... end
      return f(10, 20, 30)
    `),
    [3, 10, 20, 30],
  );
});

test("a call expands only in the final argument position", () => {
  assert.deepEqual(
    run(`
      local function two() return 1, 2 end
      local function count(...) return select("#", ...) end
      return count(two(), two()), count(two())
    `),
    [3, 2],
  );
});

test("table constructors", () => {
  const vm = new LuauVM();
  const t = vm.eval("return {1, 2, x = 3, [10] = 4}")[0];
  assert.ok(t instanceof LuaTable);
  assert.equal(t.get(1), 1);
  assert.equal(t.get("x"), 3);
  assert.equal(t.get(10), 4);
  assert.equal(t.length, 2);
});

test("a trailing call expands into a table constructor", () => {
  const t = run(`
    local function three() return 1, 2, 3 end
    return {0, three()}
  `)[0];
  assert.equal(t.length, 4);
  assert.equal(t.get(4), 3);
});

test("control flow", () => {
  assert.equal(
    run(`
      local total = 0
      for i = 1, 10 do
        if i % 2 == 0 then total = total + i end
      end
      return total
    `)[0],
    30,
  );
  assert.equal(run("local i = 0 while i < 5 do i = i + 1 end return i")[0], 5);
  assert.equal(run("local i = 0 repeat i = i + 1 until i >= 3 return i")[0], 3);
});

test("repeat's condition sees the body's locals", () => {
  assert.equal(run("local n = 0 repeat local done = true n = n + 1 until done return n")[0], 1);
});

test("break and continue", () => {
  assert.equal(
    run(`
      local total = 0
      for i = 1, 10 do
        if i > 5 then break end
        if i % 2 == 1 then continue end
        total = total + i
      end
      return total
    `)[0],
    6,
  );
});

test("continue works in while and repeat loops", () => {
  assert.equal(
    run(`
      local i, total = 0, 0
      while i < 5 do
        i = i + 1
        if i == 3 then continue end
        total = total + i
      end
      return total
    `)[0],
    12,
  );
});

test("numeric for with a negative step", () => {
  assert.deepEqual(
    run(`
      local out = {}
      for i = 5, 1, -2 do table.insert(out, i) end
      return out[1], out[2], out[3], #out
    `),
    [5, 3, 1, 3],
  );
});

test("a zero step is an error", () => {
  assert.throws(() => run("for i = 1, 10, 0 do end"), /step is zero/);
});

test("generic for over pairs and ipairs", () => {
  assert.equal(
    run(`
      local t = {10, 20, 30}
      local sum = 0
      for _, v in ipairs(t) do sum = sum + v end
      return sum
    `)[0],
    60,
  );
});

test("a table can be iterated directly", () => {
  assert.equal(
    run(`
      local sum = 0
      for k, v in {5, 6, 7} do sum = sum + v end
      return sum
    `)[0],
    18,
  );
});

test("methods and self", () => {
  assert.equal(
    run(`
      local Counter = {}
      Counter.__index = Counter
      function Counter.new() return setmetatable({n = 0}, Counter) end
      function Counter:bump(by) self.n = self.n + (by or 1) return self.n end
      local c = Counter.new()
      c:bump()
      return c:bump(5)
    `)[0],
    6,
  );
});

test("compound assignment", () => {
  assert.deepEqual(
    run(`
      local n = 10
      n += 5
      n -= 3
      n *= 2
      n /= 4
      local s = "a"
      s ..= "b"
      return n, s
    `),
    [6, "ab"],
  );
});

test("compound assignment on a table field", () => {
  assert.equal(run("local t = {n = 1} t.n += 4 return t.n")[0], 5);
});

test("string interpolation", () => {
  assert.equal(
    run("local name, n = 'world', 3 return `hello {name} x{n}`")[0],
    "hello world x3",
  );
  assert.equal(run("return `sum: {1 + 2}`")[0], "sum: 3");
  assert.equal(run("return `nested {`inner {1}`}`")[0], "nested inner 1");
});

test("if-else expressions", () => {
  assert.equal(run("return if true then 'yes' else 'no'")[0], "yes");
  assert.equal(run("local n = 5 return if n > 10 then 'big' elseif n > 3 then 'mid' else 'small'")[0], "mid");
});

test("type annotations are accepted and erased", () => {
  assert.equal(
    run(`
      type Point = { x: number, y: number }
      local function dist(p: Point, scale: number?): number
        return (p.x * p.x + p.y * p.y) * (scale or 1)
      end
      local p: Point = {x = 3, y = 4}
      return dist(p)
    `)[0],
    25,
  );
});

test("generic type parameters and casts are erased", () => {
  assert.equal(
    run(`
      type Box<T> = { value: T }
      local b: Box<number> = { value = 7 }
      local n = b.value :: number
      return n
    `)[0],
    7,
  );
});

test("comments, including long ones", () => {
  assert.equal(
    run(`
      -- a line comment
      --[[ a long
           comment ]]
      local x = 5 -- trailing
      return x
    `)[0],
    5,
  );
});

test("long strings", () => {
  assert.equal(run("return [[line1\nline2]]")[0], "line1\nline2");
  assert.equal(run("return [==[has ]] inside]==]")[0], "has ]] inside");
});

test("escape sequences", () => {
  assert.equal(run('return "a\\tb\\nc"')[0], "a\tb\nc");
  assert.equal(run('return "\\65\\66"')[0], "AB");
  assert.equal(run('return "\\x41"')[0], "A");
  assert.equal(run('return "\\u{48}i"')[0], "Hi");
});

test("number literals", () => {
  assert.equal(evalOne("0xFF"), 255);
  assert.equal(evalOne("0b1010"), 10);
  assert.equal(evalOne("1e3"), 1000);
  assert.equal(evalOne("1_000_000"), 1000000);
  assert.equal(evalOne(".5"), 0.5);
});

test("syntax errors report the line", () => {
  assert.throws(
    () => run("local x = 1\nlocal y = = 2"),
    (err) => err instanceof LuauSyntaxError && err.line === 2,
  );
  assert.throws(() => run("if true then"), LuauSyntaxError);
  assert.throws(() => run("local x ="), LuauSyntaxError);
});

test("a bare expression is not a valid statement", () => {
  assert.throws(() => run("1 + 1"), LuauSyntaxError);
});

test("print goes through the host hook", () => {
  assert.deepEqual(collectPrints('print("a", 1, true, nil)'), ["a\t1\ttrue\tnil"]);
});
