/**
 * Roblox-style event object. Connections fire in the order they were made and a
 * handler that throws is reported without stopping the other listeners.
 */
export type Connection = {
  readonly Connected: boolean;
  Disconnect(): void;
};

type Handler<A extends unknown[]> = (...args: A) => void;

export class Signal<A extends unknown[] = unknown[]> {
  private handlers: Array<{ fn: Handler<A>; once: boolean; alive: boolean }> = [];
  private waiters: Array<(args: A) => void> = [];

  /** Reported instead of thrown so one bad listener cannot break a frame. */
  static onError: (err: unknown) => void = (err) => {
    console.error("[signal] handler error:", err);
  };

  Connect(fn: Handler<A>): Connection {
    const entry = { fn, once: false, alive: true };
    this.handlers.push(entry);
    return {
      get Connected() {
        return entry.alive;
      },
      Disconnect: () => {
        entry.alive = false;
        const i = this.handlers.indexOf(entry);
        if (i >= 0) this.handlers.splice(i, 1);
      },
    };
  }

  Once(fn: Handler<A>): Connection {
    const conn = this.Connect(fn);
    const entry = this.handlers[this.handlers.length - 1];
    if (entry) entry.once = true;
    return conn;
  }

  /** Resolves with the argument tuple of the next fire. */
  Wait(): Promise<A> {
    return new Promise<A>((resolve) => this.waiters.push(resolve));
  }

  Fire(...args: A): void {
    // Snapshot: a handler may connect or disconnect during dispatch.
    for (const entry of this.handlers.slice()) {
      if (!entry.alive) continue;
      if (entry.once) {
        entry.alive = false;
        const i = this.handlers.indexOf(entry);
        if (i >= 0) this.handlers.splice(i, 1);
      }
      try {
        entry.fn(...args);
      } catch (err) {
        Signal.onError(err);
      }
    }
    if (this.waiters.length) {
      const pending = this.waiters;
      this.waiters = [];
      for (const resolve of pending) resolve(args);
    }
  }

  DisconnectAll(): void {
    for (const entry of this.handlers) entry.alive = false;
    this.handlers = [];
  }

  get connectionCount(): number {
    return this.handlers.length;
  }
}
