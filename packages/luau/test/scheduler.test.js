import { test } from "node:test";
import assert from "node:assert/strict";
import { LuauVM } from "../dist/index.js";

/** Runs a script as a thread and steps the scheduler `frames` times. */
function drive(source, frames = 10, dt = 1 / 60) {
  const vm = new LuauVM();
  const prints = [];
  const errors = [];
  vm.onPrint = (t) => prints.push(t);
  vm.onError = (err) => errors.push(err.message);
  vm.run(source, "test");
  for (let i = 0; i < frames; i++) vm.step(dt);
  return { vm, prints, errors };
}

test("coroutine.create, resume and status", () => {
  const vm = new LuauVM();
  assert.deepEqual(
    vm.eval(`
      local co = coroutine.create(function(a)
        local b = coroutine.yield(a + 1)
        return b * 2
      end)
      local ok1, v1 = coroutine.resume(co, 10)
      local status = coroutine.status(co)
      local ok2, v2 = coroutine.resume(co, 5)
      return ok1, v1, status, ok2, v2, coroutine.status(co)
    `),
    [true, 11, "suspended", true, 10, "dead"],
  );
});

test("resuming a dead coroutine fails cleanly", () => {
  const vm = new LuauVM();
  const [ok, err] = vm.eval(`
    local co = coroutine.create(function() return 1 end)
    coroutine.resume(co)
    return coroutine.resume(co)
  `);
  assert.equal(ok, false);
  assert.match(String(err), /dead coroutine/);
});

test("an error inside a coroutine is returned by resume", () => {
  const vm = new LuauVM();
  const [ok, err] = vm.eval(`
    local co = coroutine.create(function() error("inside") end)
    return coroutine.resume(co)
  `);
  assert.equal(ok, false);
  assert.match(String(err), /inside/);
});

test("coroutine.wrap returns values and propagates errors", () => {
  const vm = new LuauVM();
  assert.equal(
    vm.eval(`
      local gen = coroutine.wrap(function()
        coroutine.yield(1)
        coroutine.yield(2)
      end)
      return gen() + gen()
    `)[0],
    3,
  );
  assert.equal(
    vm.eval(`
      local f = coroutine.wrap(function() error("wrapped") end)
      local ok, err = pcall(f)
      return ok
    `)[0],
    false,
  );
});

test("a coroutine used as a generator yields a sequence", () => {
  const vm = new LuauVM();
  assert.equal(
    vm.eval(`
      local function range(n)
        return coroutine.wrap(function()
          for i = 1, n do coroutine.yield(i) end
        end)
      end
      local sum = 0
      for i in range(4) do sum = sum + i end
      return sum
    `)[0],
    10,
  );
});

test("task.wait suspends and resumes on a later frame", () => {
  const { prints } = drive(
    `
      print("before")
      task.wait(0.1)
      print("after")
    `,
    2, // Two 1/60s frames is not yet 0.1s.
  );
  assert.deepEqual(prints, ["before"], "the wait should not have elapsed yet");
});

test("task.wait resumes once enough time passes", () => {
  const { prints } = drive(
    `
      print("before")
      task.wait(0.1)
      print("after")
    `,
    20,
  );
  assert.deepEqual(prints, ["before", "after"]);
});

test("a loop with task.wait yields each iteration instead of spinning", () => {
  const { prints } = drive(
    `
      for i = 1, 3 do
        print("tick " .. i)
        task.wait(0.05)
      end
    `,
    30,
  );
  assert.deepEqual(prints, ["tick 1", "tick 2", "tick 3"]);
});

test("an infinite loop with task.wait does not hang a frame", () => {
  const { vm, prints } = drive(
    `
      while true do
        print("beat")
        task.wait(0.1)
      end
    `,
    1,
  );
  assert.deepEqual(prints, ["beat"], "the first pass runs, then the loop parks");

  // One simulated second at 60fps. A 0.1s wait should beat about ten times:
  // the point is that it neither spins (60+) nor stalls (1).
  for (let i = 0; i < 60; i++) vm.step(1 / 60);
  assert.ok(
    prints.length >= 9 && prints.length <= 12,
    `expected ~10 beats in one second, got ${prints.length}`,
  );
  assert.equal(vm.scheduler.threadCount, 1, "the loop is still alive and parked");
});

test("task.wait() with no argument resumes on the next frame", () => {
  const { prints } = drive(
    `
      for i = 1, 3 do
        print(i)
        task.wait()
      end
    `,
    5,
  );
  assert.deepEqual(prints, ["1", "2", "3"]);
});

test("task.spawn starts another thread", () => {
  const { prints } = drive(
    `
      task.spawn(function() print("spawned") end)
      print("main")
    `,
    3,
  );
  // The spawning thread finishes its own statement list first.
  assert.deepEqual(prints.sort(), ["main", "spawned"]);
});

test("task.delay defers by the given time", () => {
  const vm = new LuauVM();
  const prints = [];
  vm.onPrint = (t) => prints.push(t);
  vm.run(`task.delay(0.2, function() print("late") end)`, "test");
  for (let i = 0; i < 5; i++) vm.step(1 / 60);
  assert.deepEqual(prints, [], "not yet due");
  for (let i = 0; i < 15; i++) vm.step(1 / 60);
  assert.deepEqual(prints, ["late"]);
});

test("task.cancel stops a pending thread", () => {
  const vm = new LuauVM();
  const prints = [];
  vm.onPrint = (t) => prints.push(t);
  vm.run(
    `
      local t = task.delay(0.1, function() print("should not run") end)
      task.cancel(t)
    `,
    "test",
  );
  for (let i = 0; i < 20; i++) vm.step(1 / 60);
  assert.deepEqual(prints, []);
});

test("the legacy wait() global still works", () => {
  const { prints } = drive(`print("a") wait(0.05) print("b")`, 20);
  assert.deepEqual(prints, ["a", "b"]);
});

test("task.wait reports how long it actually waited", () => {
  const vm = new LuauVM();
  const prints = [];
  vm.onPrint = (t) => prints.push(t);
  vm.run(`local elapsed = task.wait(0.1) print(elapsed >= 0.1)`, "test");
  for (let i = 0; i < 20; i++) vm.step(1 / 60);
  assert.deepEqual(prints, ["true"]);
});

test("a thread that errors is reported and does not stop the others", () => {
  const vm = new LuauVM();
  const prints = [];
  const errors = [];
  vm.onPrint = (t) => prints.push(t);
  vm.onError = (err) => errors.push(err.message);
  vm.run(`error("thread one failed")`, "one");
  vm.run(`print("thread two ran")`, "two");
  vm.step(1 / 60);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /thread one failed/);
  assert.deepEqual(prints, ["thread two ran"]);
});

test("dead threads are cleaned up", () => {
  const vm = new LuauVM();
  vm.run(`print("done")`, "t");
  assert.equal(vm.scheduler.threadCount, 1);
  vm.step(1 / 60);
  assert.equal(vm.scheduler.threadCount, 0);
});

test("a thread waiting forever is retained but never runs again", () => {
  const vm = new LuauVM();
  const prints = [];
  vm.onPrint = (t) => prints.push(t);
  // coroutine.yield with no resumer parks the thread indefinitely.
  vm.run(`print("start") coroutine.yield() print("never")`, "t");
  for (let i = 0; i < 50; i++) vm.step(1 / 60);
  assert.deepEqual(prints, ["start"]);
});

test("drain runs queued work to completion", () => {
  const vm = new LuauVM();
  const prints = [];
  vm.onPrint = (t) => prints.push(t);
  vm.run(
    `
      for i = 1, 5 do
        print(i)
        task.wait(0.01)
      end
    `,
    "t",
  );
  vm.scheduler.drain();
  assert.deepEqual(prints, ["1", "2", "3", "4", "5"]);
});

test("the instruction budget is per resume, not per lifetime", () => {
  // A loop that waits each pass should never trip the budget, however long it runs.
  const vm = new LuauVM({ maxSteps: 20000 });
  const errors = [];
  vm.onError = (err) => errors.push(err.message);
  vm.run(
    `
      for i = 1, 200 do
        local x = 0
        for j = 1, 50 do x = x + j end
        task.wait()
      end
      print("finished")
    `,
    "t",
  );
  const prints = [];
  vm.onPrint = (t) => prints.push(t);
  for (let i = 0; i < 400; i++) vm.step(1 / 60);
  assert.deepEqual(errors, []);
  assert.deepEqual(prints, ["finished"]);
});

test("a thread that never yields is killed by the budget", () => {
  const vm = new LuauVM({ maxSteps: 20000 });
  const errors = [];
  vm.onError = (err) => errors.push(err.message);
  vm.run(`while true do end`, "runaway");
  vm.step(1 / 60);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /exceeded .* instructions/);
  assert.equal(vm.scheduler.threadCount, 0, "the runaway thread is removed");
});

test("pcall can catch across a yield", () => {
  const vm = new LuauVM();
  const prints = [];
  vm.onPrint = (t) => prints.push(t);
  vm.run(
    `
      local ok, err = pcall(function()
        task.wait(0.05)
        error("after waiting")
      end)
      print(ok, string.match(tostring(err), "after waiting"))
    `,
    "t",
  );
  vm.scheduler.drain();
  assert.deepEqual(prints, ["false\tafter waiting"]);
});

test("a yield inside a sync eval is refused rather than hanging", () => {
  const vm = new LuauVM();
  assert.throws(() => vm.eval("task.wait(1)"), /cannot yield/);
});
