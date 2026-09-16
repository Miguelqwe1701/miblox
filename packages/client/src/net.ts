import {
  DataModel,
  Player,
  ReplicaTree,
  PROTOCOL_VERSION,
  Chunk,
  decodeChunkPlanes,
  parseChunkKey,
  type ClientMessage,
  type ServerMessage,
} from "@miblox/core";

export interface ConnectionInfo {
  host: string;
  port: number;
  /** Signed ticket from the portal, or omitted to join as a guest. */
  ticket?: string;
  username: string;
  platform: string;
  /** Use wss:// when the page itself is served over https. */
  secure?: boolean;
}

export type ConnectionState = "connecting" | "joined" | "closed" | "error";

export interface NetEvents {
  onState?(state: ConnectionState, detail?: string): void;
  onHello?(hello: Extract<ServerMessage, { t: "hello" }>): void;
  onChunks?(keys: string[]): void;
  onChat?(from: string, text: string): void;
  onRemote?(id: string, args: unknown[]): void;
  onDelta?(): void;
}

/**
 * The client's view of the server.
 *
 * Everything the server owns arrives as deltas and is applied to a local
 * DataModel through ReplicaTree, so the rest of the client reads the same
 * instance tree the server has rather than a parallel set of view models.
 */
export class Connection {
  readonly game = new DataModel();
  readonly replica: ReplicaTree;
  /** Round-trip time in milliseconds, updated by the ping loop. */
  ping = 0;
  state: ConnectionState = "connecting";
  localPlayer: Player | null = null;
  serverAuthoritative = true;
  placeName = "";
  tickRate = 30;

  private socket: WebSocket | null = null;
  private seq = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private queued: ClientMessage[] = [];
  /** Set when we closed the socket ourselves, so it is not reported as a fault. */
  private closingDeliberately = false;

  constructor(
    private readonly info: ConnectionInfo,
    private readonly events: NetEvents = {},
  ) {
    // The client applies changes rather than originating them, so it must not
    // journal them as if they were local edits.
    this.game.recordChanges = false;
    this.replica = new ReplicaTree(this.game);
  }

  connect(): void {
    const scheme = this.info.secure ? "wss" : "ws";
    const socket = new WebSocket(`${scheme}://${this.info.host}:${this.info.port}`);
    this.socket = socket;
    this.setState("connecting");

    socket.addEventListener("open", () => {
      this.send({
        t: "join",
        name: this.info.username,
        platform: this.info.platform,
        protocol: PROTOCOL_VERSION,
        session: this.info.ticket,
      });
    });

    socket.addEventListener("message", (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      this.handle(message);
    });

    socket.addEventListener("close", (event) => {
      this.stopPinging();
      // Leaving a world closes the socket on purpose; telling the player their
      // connection dropped, and tearing down the world they just joined, is
      // exactly wrong.
      if (this.closingDeliberately) return;
      this.setState("closed", event.reason || "Connection closed");
    });
    socket.addEventListener("error", () => {
      if (this.closingDeliberately) return;
      this.setState("error", "Could not reach the game server");
    });
  }

  disconnect(): void {
    this.closingDeliberately = true;
    this.stopPinging();
    this.socket?.close();
    this.socket = null;
  }

  private setState(state: ConnectionState, detail?: string): void {
    this.state = state;
    this.events.onState?.(state, detail);
  }

  send(message: ClientMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      // Buffer briefly so a send during the handshake is not simply lost.
      if (this.queued.length < 64) this.queued.push(message);
      return;
    }
    this.socket.send(JSON.stringify(message));
  }

  private flushQueue(): void {
    const pending = this.queued;
    this.queued = [];
    for (const message of pending) this.send(message);
  }

  private handle(message: ServerMessage): void {
    switch (message.t) {
      case "hello": {
        this.replica.bindRoot(message.rootId);
        // Services exist on both sides already; bind them so parents resolve.
        for (const service of this.game.GetChildren()) {
          this.replica.byId.set(service.id, service);
        }
        this.placeName = message.placeName;
        this.tickRate = message.tickRate;
        this.serverAuthoritative = message.serverAuthoritative;
        this.game.Terrain.voxels.gen = { ...this.game.Terrain.voxels.gen, ...message.terrain };
        // Terrain arrives from the server; never generate it locally, or the
        // two would disagree wherever a player has edited the world.
        this.game.Terrain.voxels.generateOnAccess = false;
        this.pendingPlayerId = message.playerId;
        this.setState("joined");
        this.flushQueue();
        this.startPinging();
        this.events.onHello?.(message);
        break;
      }

      case "delta": {
        this.replica.apply(message.delta);
        this.resolveLocalPlayer();
        this.events.onDelta?.();
        break;
      }

      case "chunks": {
        const keys: string[] = [];
        for (const entry of message.chunks) {
          const [cx, cy, cz] = parseChunkKey(entry.key);
          const planes = decodeChunkPlanes(entry.rle);
          this.game.Terrain.voxels.putChunk(
            new Chunk(cx, cy, cz, planes.data, planes.occupancy),
          );
          keys.push(entry.key);
        }
        this.game.Terrain.voxels.dirtyChunks.clear();
        this.events.onChunks?.(keys);
        break;
      }

      case "remote":
        this.events.onRemote?.(message.id, message.args);
        break;

      case "chat":
        this.events.onChat?.(message.from, message.text);
        break;

      case "kick":
        this.setState("closed", message.reason);
        this.socket?.close();
        break;

      case "pong":
        this.ping = Math.round(performance.now() - message.time);
        break;

      default:
        break;
    }
  }

  private pendingPlayerId: string | null = null;

  private resolveLocalPlayer(): void {
    if (this.localPlayer || !this.pendingPlayerId) return;
    const resolved = this.replica.resolve(this.pendingPlayerId);
    if (resolved instanceof Player) {
      this.localPlayer = resolved;
      this.game.Players.LocalPlayer = resolved;
      this.pendingPlayerId = null;
    }
  }

  /** Server-assigned id of the local player, used to test part ownership. */
  get localPlayerId(): string | null {
    return this.localPlayer ? this.replica.idOf(this.localPlayer) : this.pendingPlayerId;
  }

  sendInput(move: [number, number, number], jump: boolean, look?: [number, number, number]): void {
    this.send({ t: "input", seq: ++this.seq, move, jump, look });
  }

  /** Reports state for parts this client owns and simulates. */
  sendState(parts: Array<{ id: string; cf: number[]; v: number[] }>): void {
    if (!parts.length || this.serverAuthoritative) return;
    this.send({ t: "state", seq: ++this.seq, parts });
  }

  requestChunks(keys: string[]): void {
    if (keys.length) this.send({ t: "wantChunks", keys });
  }

  editTerrain(op: "set" | "ball" | "block", a: number[], m: number, b?: number[]): void {
    this.send({ t: "edit", op, a, b, m });
  }

  chat(text: string): void {
    this.send({ t: "chat", text });
  }

  fireRemote(id: string, args: unknown[]): void {
    this.send({ t: "remote", id, args });
  }

  private startPinging(): void {
    this.stopPinging();
    this.pingTimer = setInterval(() => {
      this.send({ t: "ping", time: performance.now() });
    }, 2000);
  }

  private stopPinging(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }
}
