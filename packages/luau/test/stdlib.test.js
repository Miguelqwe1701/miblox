import { test } from "node:test";
import assert from "node:assert/strict";
import { LuauVM } from "../dist/index.js";

function run(source) {
  return new LuauVM().eval(source);
}
const one = (source) => run(`return ${source}`)[0];

test("type and typeof", () => {
  assert.equal(one("type(nil)"), "nil");
  assert.equal(one("type(1)"), "number");
  assert.equal(one('type("s")'), "string");
  assert.equal(one("type({})"), "table");
  assert.equal(one("type(print)"), "function");
  assert.equal(one("type(true)"), "boolean");
});

test("tostring and tonumber", () => {
  assert.equal(one("tostring(1)"), "1");
  assert.equal(one("tostring(1.5)"), "1.5");
  assert.equal(one("tostring(nil)"), "nil");
  assert.equal(one('tonumber("42")'), 42);
  assert.equal(one('tonumber("0x1F")'), 31);
  assert.equal(one('tonumber("ff", 16)'), 255);
  assert.equal(one('tonumber("nope")'), undefined);
  assert.equal(one('tonumber("")'), undefined);
});

test("assert passes its arguments through", () => {
  assert.deepEqual(run('return assert(1, "msg")'), [1, "msg"]);
  assert.throws(() => run("assert(false)"), /assertion failed/);
  assert.throws(() => run('assert(nil, "custom")'), /custom/);
});

test("pcall catches errors", () => {
  assert.deepEqual(run('return pcall(function() error("boom") end)').slice(0, 1), [false]);
  assert.deepEqual(run("return pcall(function() return 1, 2 end)"), [true, 1, 2]);
  assert.ok(String(run('return select(2, pcall(function() error("boom") end))')[0]).includes("boom"));
});

test("pcall catches runtime type errors too", () => {
  assert.equal(run("return (pcall(function() return nil + 1 end))")[0], false);
  assert.equal(run("return (pcall(function() local t = nil return t.x end))")[0], false);
});

test("error can carry a non-string value", () => {
  const [ok, value] = run(`
    return pcall(function() error({code = 42}) end)
  `);
  assert.equal(ok, false);
  assert.equal(value.get("code"), 42);
});

test("xpcall runs its handler", () => {
  assert.deepEqual(
    run(`
      return xpcall(function() error("x") end, function(e) return "handled" end)
    `),
    [false, "handled"],
  );
});

test("select", () => {
  assert.equal(one('select("#", 1, 2, 3)'), 3);
  assert.deepEqual(run("return select(2, 'a', 'b', 'c')"), ["b", "c"]);
  assert.deepEqual(run("return select(-1, 'a', 'b', 'c')"), ["c"]);
});

test("string library basics", () => {
  assert.equal(one('string.upper("abc")'), "ABC");
  assert.equal(one('string.rep("ab", 3)'), "ababab");
  assert.equal(one('string.rep("a", 3, "-")'), "a-a-a");
  assert.equal(one('string.reverse("abc")'), "cba");
  assert.equal(one('string.len("hello")'), 5);
  assert.equal(one('("hi"):upper()'), "HI", "string methods resolve via the metatable");
});

test("string.sub handles negative indices", () => {
  assert.equal(one('string.sub("hello", 2, 4)'), "ell");
  assert.equal(one('string.sub("hello", -3)'), "llo");
  assert.equal(one('string.sub("hello", 2)'), "ello");
  assert.equal(one('string.sub("hello", -100, 100)'), "hello");
  assert.equal(one('string.sub("hello", 4, 2)'), "");
});

test("string.format", () => {
  assert.equal(one('string.format("%d apples", 5)'), "5 apples");
  assert.equal(one('string.format("%.2f", 3.14159)'), "3.14");
  assert.equal(one('string.format("%5.1f|", 3.14159)'), "  3.1|");
  assert.equal(one('string.format("%-5d|", 42)'), "42   |");
  assert.equal(one('string.format("%05d", 42)'), "00042");
  assert.equal(one('string.format("%s and %s", "a", "b")'), "a and b");
  assert.equal(one('string.format("%x", 255)'), "ff");
  assert.equal(one('string.format("%X", 255)'), "FF");
  assert.equal(one('string.format("100%%")'), "100%");
});

test("string.byte and char", () => {
  assert.equal(one('string.byte("A")'), 65);
  assert.deepEqual(run('return string.byte("AB", 1, 2)'), [65, 66]);
  assert.equal(one("string.char(72, 105)"), "Hi");
});

test("string.split", () => {
  const t = one('string.split("a,b,c", ",")');
  assert.equal(t.length, 3);
  assert.equal(t.get(2), "b");
});

test("string.find with plain text and patterns", () => {
  assert.deepEqual(run('return string.find("hello world", "world")'), [7, 11]);
  assert.deepEqual(run('return string.find("a.b", ".", 1, true)'), [2, 2]);
  assert.deepEqual(run('return string.find("hello", "l+")'), [3, 4]);
  assert.equal(one('string.find("abc", "z")'), undefined);
});

test("string.match with captures", () => {
  assert.equal(one('string.match("hello world", "%w+")'), "hello");
  assert.deepEqual(run('return string.match("key=value", "(%w+)=(%w+)")'), ["key", "value"]);
  assert.equal(one('string.match("2024-01-15", "%d+%-%d+")'), "2024-01");
  assert.equal(one('string.match("abc", "^a")'), "a");
  assert.equal(one('string.match("abc", "^b")'), undefined);
});

test("character classes and sets", () => {
  assert.equal(one('string.match("  hi", "%s+")'), "  ");
  assert.equal(one('string.match("abc123", "%a+")'), "abc");
  assert.equal(one('string.match("abc123", "%d+")'), "123");
  assert.equal(one('string.match("a-b", "[%a%-]+")'), "a-b");
  assert.equal(one('string.match("abc", "[^b]+")'), "a");
});

test("lazy and greedy quantifiers differ", () => {
  assert.equal(one('string.match("<a><b>", "<(.-)>")'), "a", "- is lazy");
  assert.equal(one('string.match("<a><b>", "<(.*)>")'), "a><b", "* is greedy");
});

test("string.gmatch iterates every match", () => {
  assert.equal(
    run(`
      local out = {}
      for word in string.gmatch("the quick brown", "%a+") do table.insert(out, word) end
      return table.concat(out, "|")
    `)[0],
    "the|quick|brown",
  );
});

test("string.gmatch with two captures", () => {
  assert.equal(
    run(`
      local out = {}
      for k, v in string.gmatch("a=1, b=2", "(%w+)=(%w+)") do
        table.insert(out, k .. v)
      end
      return table.concat(out, ",")
    `)[0],
    "a1,b2",
  );
});

test("string.gsub with a string, table and function", () => {
  assert.deepEqual(run('return string.gsub("hello world", "o", "0")'), ["hell0 w0rld", 2]);
  assert.deepEqual(run('return string.gsub("hello", "l", "L", 1)'), ["heLlo", 1]);
  assert.equal(one('string.gsub("hello world", "(%w+)", "<%1>")'), "<hello> <world>");
  assert.equal(
    one('string.gsub("abc", "%a", function(c) return c:upper() end)'),
    "ABC",
  );
  assert.equal(one('string.gsub("$name", "%$(%w+)", {name = "Bob"})'), "Bob");
});

test("gsub with an empty match still terminates", () => {
  assert.deepEqual(run('return string.gsub("abc", "x*", "-")'), ["-a-b-c-", 4]);
});

test("%b matches balanced delimiters", () => {
  assert.equal(one('string.match("(a(b)c) rest", "%b()")'), "(a(b)c)");
});

test("table.insert and remove", () => {
  assert.equal(
    run(`
      local t = {}
      table.insert(t, "a")
      table.insert(t, "c")
      table.insert(t, 2, "b")
      return table.concat(t, "")
    `)[0],
    "abc",
  );
  assert.deepEqual(
    run(`
      local t = {1, 2, 3}
      local removed = table.remove(t, 1)
      return removed, #t, t[1]
    `),
    [1, 2, 2],
  );
  assert.equal(run("local t = {1,2,3} table.remove(t) return #t")[0], 2);
});

test("table.concat, find, clone and create", () => {
  assert.equal(one('table.concat({1, 2, 3}, "-")'), "1-2-3");
  assert.equal(one('table.find({"a", "b"}, "b")'), 2);
  assert.equal(one('table.find({"a"}, "z")'), undefined);
  assert.equal(one("#table.create(4, 0)"), 4);
  assert.equal(
    run("local a = {1,2} local b = table.clone(a) b[1] = 9 return a[1]")[0],
    1,
  );
});

test("table.sort, with and without a comparator", () => {
  assert.equal(
    run("local t = {3, 1, 2} table.sort(t) return table.concat(t, '')")[0],
    "123",
  );
  assert.equal(
    run("local t = {1, 2, 3} table.sort(t, function(a, b) return a > b end) return table.concat(t, '')")[0],
    "321",
  );
});

test("table.unpack and pack", () => {
  assert.deepEqual(run("return table.unpack({1, 2, 3})"), [1, 2, 3]);
  assert.equal(run("local t = table.pack(1, 2, 3) return t.n")[0], 3);
});

test("math library", () => {
  assert.equal(one("math.floor(3.7)"), 3);
  assert.equal(one("math.ceil(3.2)"), 4);
  assert.equal(one("math.abs(-5)"), 5);
  assert.equal(one("math.max(1, 9, 3)"), 9);
  assert.equal(one("math.min(1, 9, 3)"), 1);
  assert.equal(one("math.clamp(15, 0, 10)"), 10);
  assert.equal(one("math.round(2.5)"), 3);
  assert.equal(one("math.round(-2.5)"), -3, "Lua rounds halves away from zero");
  assert.equal(one("math.sqrt(16)"), 4);
  assert.ok(Math.abs(one("math.pi") - Math.PI) < 1e-12);
  assert.equal(one("math.huge > 1e308"), true);
});

test("math.random is seedable and reproducible", () => {
  const first = run("math.randomseed(7) return math.random(1, 100), math.random(1, 100)");
  const second = run("math.randomseed(7) return math.random(1, 100), math.random(1, 100)");
  assert.deepEqual(first, second);
  assert.ok(first[0] >= 1 && first[0] <= 100);
});

test("metatables: __index, __newindex and arithmetic", () => {
  assert.equal(
    run(`
      local base = {greet = function() return "hi" end}
      local t = setmetatable({}, {__index = base})
      return t.greet()
    `)[0],
    "hi",
  );
  assert.equal(
    run(`
      local log = {}
      local t = setmetatable({}, {__newindex = function(_, k, v) log[k] = v end})
      t.x = 5
      return log.x, rawget(t, "x")
    `)[0],
    5,
  );
  assert.equal(
    run(`
      local mt = {__add = function(a, b) return a.v + b.v end}
      local a = setmetatable({v = 2}, mt)
      local b = setmetatable({v = 3}, mt)
      return a + b
    `)[0],
    5,
  );
});

test("metatables: __call, __tostring, __eq, __lt, __len, __concat", () => {
  assert.equal(
    run(`
      local t = setmetatable({}, {__call = function(self, n) return n * 2 end})
      return t(21)
    `)[0],
    42,
  );
  assert.equal(
    run(`
      local t = setmetatable({}, {__tostring = function() return "custom" end})
      return tostring(t)
    `)[0],
    "custom",
  );
  assert.equal(
    run(`
      local mt = {__eq = function(a, b) return a.v == b.v end}
      return setmetatable({v = 1}, mt) == setmetatable({v = 1}, mt)
    `)[0],
    true,
  );
  assert.equal(
    run(`
      local mt = {__lt = function(a, b) return a.v < b.v end}
      return setmetatable({v = 1}, mt) < setmetatable({v = 2}, mt)
    `)[0],
    true,
  );
  assert.equal(
    run('return #setmetatable({}, {__len = function() return 99 end})')[0],
    99,
  );
  assert.equal(
    run(`
      local mt = {__concat = function(a, b) return "joined" end}
      return setmetatable({}, mt) .. "x"
    `)[0],
    "joined",
  );
});

test("__index chains through several levels", () => {
  assert.equal(
    run(`
      local a = {x = 1}
      local b = setmetatable({}, {__index = a})
      local c = setmetatable({}, {__index = b})
      return c.x
    `)[0],
    1,
  );
});

test("rawget and rawset bypass metamethods", () => {
  assert.equal(
    run(`
      local hits = 0
      local t = setmetatable({}, {__index = function() hits = hits + 1 return 1 end})
      local _ = rawget(t, "missing")
      return hits
    `)[0],
    0,
  );
});

test("inheritance through metatables", () => {
  assert.deepEqual(
    run(`
      local Animal = {}
      Animal.__index = Animal
      function Animal.new(name) return setmetatable({name = name}, Animal) end
      function Animal:speak() return self.name .. " makes a sound" end

      local Dog = setmetatable({}, {__index = Animal})
      Dog.__index = Dog
      function Dog.new(name)
        local self = Animal.new(name)
        return setmetatable(self, Dog)
      end
      function Dog:speak() return self.name .. " barks" end

      return Animal.new("Cat"):speak(), Dog.new("Rex"):speak()
    `),
    ["Cat makes a sound", "Rex barks"],
  );
});

test("a runaway loop is stopped rather than hanging", () => {
  const vm = new LuauVM({ maxSteps: 50000 });
  assert.throws(() => vm.eval("while true do end"), /exceeded .* instructions/);
});

test("deep recursion reports a stack overflow", () => {
  assert.throws(
    () => run("local function f() return f() end return f()"),
    /stack overflow|exceeded/,
  );
});

test("runtime errors name the line and the variable", () => {
  const vm = new LuauVM();
  assert.throws(
    () => vm.eval("local t = nil\nreturn t.field"),
    (err) => /:2:/.test(err.message) && /index/.test(err.message),
  );
});
