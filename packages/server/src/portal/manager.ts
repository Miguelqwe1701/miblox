import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { PlaceProcessMessage } from "../place/main.js";

export interface GameDefinition {
  id: string;
  name: string;
  description: string;
  /** Path to the .json place file. */
  placeFile: string;
  maxPlayers?: number;
  /** Server-authoritative places never let clients simulate. */
  serverAuthoritative?: boolean;
  tickRate?: number;
  thumbnail?: string;
}

export type ServerStatus = "starting" | "running" | "stopping" | "stopped" | "crashed";

export interface GameServerInfo {
  id: string;
  gameId: string;
  status: ServerStatus;
  port: number;
  players: number;
  maxPlayers: number;
  startedAt: number;
  lastError?: string;
}

interface ManagedServer extends GameServerInfo {
  child: ChildProcess;
  ready: Promise<void>;
  /** Cleared whenever a player is present, so empty servers can be reaped. */
  emptySince: number | null;
}

export interface ServerManagerOptions {
  ticketSecret: string;
  /** First port to try; each server takes the next free one. */
  basePort?: number;
  /** Shut an empty game server down after this long. */
  idleTimeoutMs?: number;
  log?: (message: string) => void;
  /** Overrides the child entry point, for tests. */
  placeEntry?: string;
}

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Supervises game-server processes.
 *
 * A place starts on demand when the first player asks to join, and is shut
 * down once it has been empty for a while, so an idle catalogue costs nothing.
 */
export class ServerManager {
  private servers = new Map<string, ManagedServer>();
  private games = new Map<string, GameDefinition>();
  private nextPort: number;
  private readonly log: (message: string) => void;
  private readonly idleTimeoutMs: number;
  private readonly placeEntry: string;
  private reaper: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: ServerManagerOptions) {
    this.nextPort = opts.basePort ?? 7100;
    this.log = opts.log ?? ((m) => console.log(`[manager] ${m}`));
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 5 * 60 * 1000;
    this.placeEntry = opts.placeEntry ?? resolve(here, "../place/main.js");
  }

  registerGame(game: GameDefinition): void {
    this.games.set(game.id, game);
  }

  listGames(): GameDefinition[] {
    return [...this.games.values()];
  }

  getGame(id: string): GameDefinition | undefined {
    return this.games.get(id);
  }

  listServers(): GameServerInfo[] {
    return [...this.servers.values()].map(publicInfo);
  }

  start(): void {
    this.reaper ??= setInterval(() => this.reapIdle(), 30_000);
  }

  /**
   * Returns a server for `gameId`, launching one if none has room.
   *
   * Several players clicking at once must not each start a process, so an
   * in-flight launch is awaited rather than duplicated.
   */
  async acquire(gameId: string): Promise<GameServerInfo> {
    const game = this.games.get(gameId);
    if (!game) throw new Error(`No such game "${gameId}"`);

    for (const server of this.servers.values()) {
      if (server.gameId !== gameId) continue;
      if (server.status === "crashed" || server.status === "stopped") continue;
      if (server.players >= server.maxPlayers) continue;
      await server.ready;
      if (server.status === "running") return publicInfo(server);
    }
    return this.launch(game);
  }

  private async launch(game: GameDefinition): Promise<GameServerInfo> {
    const id = randomUUID().slice(0, 8);
    const port = this.nextPort++;
    const maxPlayers = game.maxPlayers ?? 32;

    this.log(`launching ${game.name} as server ${id} on port ${port}`);
    const child = fork(this.placeEntry, [], {
      env: {
        ...process.env,
        MIBLOX_PLACE_FILE: game.placeFile,
        MIBLOX_PLACE_ID: id,
        MIBLOX_PLACE_PORT: String(port),
        MIBLOX_TICKET_SECRET: this.opts.ticketSecret,
        MIBLOX_SERVER_AUTH: game.serverAuthoritative ? "1" : "0",
        MIBLOX_TICK_RATE: String(game.tickRate ?? 30),
        MIBLOX_MAX_PLAYERS: String(maxPlayers),
      },
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });

    let resolveReady: () => void;
    let rejectReady: (err: Error) => void;
    const ready = new Promise<void>((res, rej) => {
      resolveReady = res;
      rejectReady = rej;
    });

    const server: ManagedServer = {
      id,
      gameId: game.id,
      status: "starting",
      port,
      players: 0,
      maxPlayers,
      startedAt: Date.now(),
      child,
      ready,
      emptySince: Date.now(),
    };
    this.servers.set(id, server);

    // A process that never reports ready must not leave joins hanging forever.
    const startTimeout = setTimeout(() => {
      if (server.status !== "starting") return;
      server.status = "crashed";
      server.lastError = "The game server did not start in time";
      child.kill("SIGKILL");
      rejectReady(new Error(server.lastError));
    }, 20_000);

    child.on("message", (message: PlaceProcessMessage) => {
      if (message.type === "ready") {
        clearTimeout(startTimeout);
        server.status = "running";
        if (message.port) server.port = message.port;
        this.log(`server ${id} ready on port ${server.port}`);
        resolveReady();
        return;
      }
      if (message.type === "status") {
        server.players = message.players ?? 0;
        server.emptySince = server.players === 0 ? (server.emptySince ?? Date.now()) : null;
        return;
      }
      if (message.type === "error") {
        server.lastError = message.message;
        this.log(`server ${id} reported an error: ${message.message}`);
      }
    });

    child.on("exit", (code, signal) => {
      clearTimeout(startTimeout);
      const wasStopping = server.status === "stopping";
      server.status = wasStopping ? "stopped" : "crashed";
      if (!wasStopping) {
        server.lastError ??= `Process exited with ${signal ?? code}`;
        this.log(`server ${id} exited unexpectedly (${signal ?? code})`);
        rejectReady(new Error(server.lastError));
      }
      this.servers.delete(id);
    });

    await ready;
    return publicInfo(server);
  }

  /** Called when a player joins or leaves, to keep the idle reaper honest. */
  notePlayerCount(serverId: string, players: number): void {
    const server = this.servers.get(serverId);
    if (!server) return;
    server.players = players;
    server.emptySince = players === 0 ? (server.emptySince ?? Date.now()) : null;
  }

  private reapIdle(): void {
    const now = Date.now();
    for (const server of this.servers.values()) {
      if (server.status !== "running") continue;
      if (server.players > 0 || server.emptySince === null) continue;
      if (now - server.emptySince < this.idleTimeoutMs) continue;
      this.log(`stopping idle server ${server.id}`);
      void this.stop(server.id);
    }
  }

  async stop(serverId: string): Promise<void> {
    const server = this.servers.get(serverId);
    if (!server) return;
    server.status = "stopping";
    server.child.send?.({ type: "shutdown" });
    // Escalate if it does not go quietly.
    const killTimer = setTimeout(() => server.child.kill("SIGKILL"), 5000);
    await new Promise<void>((resolve) => {
      server.child.once("exit", () => {
        clearTimeout(killTimer);
        resolve();
      });
    });
  }

  async stopAll(): Promise<void> {
    if (this.reaper) clearInterval(this.reaper);
    this.reaper = null;
    await Promise.all([...this.servers.keys()].map((id) => this.stop(id)));
  }
}

function publicInfo(server: ManagedServer): GameServerInfo {
  return {
    id: server.id,
    gameId: server.gameId,
    status: server.status,
    port: server.port,
    players: server.players,
    maxPlayers: server.maxPlayers,
    startedAt: server.startedAt,
    lastError: server.lastError,
  };
}
