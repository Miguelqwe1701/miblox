import { Interpreter, type InterpreterOptions } from "./interpreter.js";
import { Scheduler, type SchedulerOptions } from "./scheduler.js";
import { installStdlib, type Host } from "./stdlib.js";
import {
  LuaError,
  LuaTable,
  type Coroutine,
  type LuaFunction,
  type LuaValue,
} from "./values.js";

export interface VMOptions extends InterpreterOptions, SchedulerOptions {}

/**
 * Interpreter, standard library and scheduler wired together. This is what the
 * server and client each create one of.
 */
export class LuauVM {
  readonly interp: Interpreter;
  readonly scheduler: Scheduler;

  constructor(opts: VMOptions = {}) {
    this.interp = new Interpreter(opts);
    this.scheduler = new Scheduler(this.interp, opts);
    const host: Host = {
      now: () => this.scheduler.now(),
      spawn: (fn, args, delay, deferred) => this.scheduler.spawn(fn, args, delay, deferred),
      cancel: (co) => this.scheduler.cancel(co),
    };
    installStdlib(this.interp, host);
  }

  get globals(): LuaTable {
    return this.interp.globals;
  }

  /** Compiles source. Throws LuauSyntaxError on bad syntax. */
  load(source: string, chunkName = "chunk"): LuaFunction {
    return this.interp.load(source, chunkName);
  }

  /** Compiles and queues a script as its own thread. */
  run(source: string, chunkName = "chunk", args: LuaValue[] = []): Coroutine {
    return this.scheduler.spawn(this.load(source, chunkName), args);
  }

  /**
   * Compiles and runs to completion right now, returning its values.
   * Throws if the script tries to yield, so it is for setup code and tests.
   */
  eval(source: string, chunkName = "eval"): LuaValue[] {
    this.interp.resetSteps();
    return this.interp.callSync(this.load(source, chunkName));
  }

  /** Advances script time by `dt` seconds, resuming any threads that are due. */
  step(dt: number): void {
    this.scheduler.step(dt);
  }

  set onError(handler: (err: LuaError, threadName: string) => void) {
    this.scheduler.onError = handler;
  }

  set onPrint(handler: (text: string) => void) {
    this.interp.onPrint = handler;
  }
}
