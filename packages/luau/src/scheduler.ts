import {
  Coroutine,
  LuaError,
  type LuaFunction,
  type LuaValue,
  type YieldRequest,
} from "./values.js";
import type { Interpreter } from "./interpreter.js";

interface Thread {
  co: Coroutine;
  gen: Generator<YieldRequest, LuaValue[], LuaValue[]>;
  /** Game time at which this thread becomes runnable again. */
  resumeAt: number;
  /** Values handed back into the generator on the next resume. */
  send: LuaValue[];
  /** Deferred threads run after every ready thread has had a turn. */
  deferred: boolean;
  /** Set while waiting on a promise, so the tick loop skips it. */
  blocked: boolean;
  cancelled: boolean;
  name: string;
}

export interface SchedulerOptions {
  /** Called when a thread dies with an error. */
  onError?: (err: LuaError, threadName: string) => void;
  /** Wall-clock budget per step, in ms, so scripts cannot stall a frame. */
  budgetMs?: number;
}

/**
 * Drives Luau threads.
 *
 * A suspended script is a paused generator: `task.wait` yields a request, the
 * scheduler parks the thread until its time comes, then resumes the generator
 * exactly where it left off. That is what makes `while true do ... wait() end`
 * work without blocking the game loop.
 */
export class Scheduler {
  private threads: Thread[] = [];
  private clock = 0;
  onError: (err: LuaError, threadName: string) => void;
  budgetMs: number;

  constructor(
    private readonly interp: Interpreter,
    opts: SchedulerOptions = {},
  ) {
    this.onError =
      opts.onError ??
      ((err, name) => {
        console.error(`[luau] ${name}: ${err.message}`);
        if (err.traceback) console.error(err.traceback);
      });
    this.budgetMs = opts.budgetMs ?? 100;
  }

  now(): number {
    return this.clock;
  }

  get threadCount(): number {
    return this.threads.length;
  }

  /** Queues a function as a new thread. Returns its coroutine handle. */
  spawn(fn: LuaFunction, args: LuaValue[] = [], delay = 0, deferred = false): Coroutine {
    const co = new Coroutine(fn);
    const thread: Thread = {
      co,
      gen: this.interp.call(fn, args),
      resumeAt: this.clock + delay,
      send: [],
      deferred,
      blocked: false,
      cancelled: false,
      name: fn.name || "thread",
    };
    co.gen = thread.gen;
    this.threads.push(thread);
    return co;
  }

  cancel(co: Coroutine): void {
    const thread = this.threads.find((t) => t.co === co);
    if (thread) thread.cancelled = true;
    co.status = "dead";
  }

  /** Runs every thread whose wait has elapsed. `dt` is in seconds. */
  step(dt: number): void {
    this.clock += dt;
    const deadline = Date.now() + this.budgetMs;

    // Snapshot: a running thread may spawn more, which run on the next step.
    const ready = this.threads.filter(
      (t) => !t.cancelled && !t.blocked && t.resumeAt <= this.clock && !t.deferred,
    );
    const deferred = this.threads.filter(
      (t) => !t.cancelled && !t.blocked && t.resumeAt <= this.clock && t.deferred,
    );

    for (const thread of [...ready, ...deferred]) {
      if (thread.cancelled) continue;
      this.runThread(thread);
      if (Date.now() > deadline) break; // Resume the rest next frame.
    }

    this.threads = this.threads.filter(
      (t) => !t.cancelled && t.co.status !== "dead",
    );
  }

  private runThread(thread: Thread): void {
    thread.co.status = "running";
    this.interp.resetSteps();
    for (;;) {
      let step: IteratorResult<YieldRequest, LuaValue[]>;
      try {
        step = thread.gen.next(thread.send);
      } catch (err) {
        thread.co.status = "dead";
        thread.cancelled = true;
        const luaErr = err instanceof LuaError ? err : new LuaError(String(err));
        this.onError(luaErr, thread.name);
        return;
      }
      thread.send = [];

      if (step.done) {
        thread.co.status = "dead";
        return;
      }

      const request = step.value;
      switch (request.kind) {
        case "wait":
          thread.co.status = "suspended";
          thread.resumeAt = this.clock + request.seconds;
          // A zero wait resumes on the next step, never in this one, so that
          // `while true do task.wait() end` cannot spin the frame.
          return;

        case "yield":
          // coroutine.yield with nobody resuming: park it indefinitely, which
          // is what Roblox does for a yield outside coroutine.resume.
          thread.co.status = "suspended";
          thread.resumeAt = Infinity;
          return;

        case "waitPromise": {
          thread.co.status = "suspended";
          thread.blocked = true;
          request.promise.then(
            (values) => {
              thread.blocked = false;
              thread.send = values;
              thread.resumeAt = this.clock;
            },
            (err) => {
              thread.blocked = false;
              thread.cancelled = true;
              thread.co.status = "dead";
              this.onError(
                err instanceof LuaError ? err : new LuaError(String(err)),
                thread.name,
              );
            },
          );
          return;
        }

        case "waitSignal":
          // The host resolves these by turning them into promises before they
          // reach the scheduler; reaching here means nothing will wake it.
          thread.co.status = "suspended";
          thread.resumeAt = Infinity;
          return;
      }
    }
  }

  /** Runs threads until none are runnable. For tests and offline tooling. */
  drain(maxSteps = 10000, dt = 1 / 60): number {
    let steps = 0;
    while (steps < maxSteps && this.hasRunnable()) {
      this.step(dt);
      steps++;
    }
    return steps;
  }

  private hasRunnable(): boolean {
    return this.threads.some(
      (t) => !t.cancelled && !t.blocked && Number.isFinite(t.resumeAt),
    );
  }

  /** Cancels every thread; used when shutting a place down. */
  clear(): void {
    for (const thread of this.threads) {
      thread.cancelled = true;
      thread.co.status = "dead";
    }
    this.threads = [];
  }
}
