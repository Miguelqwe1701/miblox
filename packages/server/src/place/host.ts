import { createServer, type Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from "@miblox/core";
import { PlaceServer, type Connection, type PlaceServerOptions } from "./place-server.js";
import { TicketError, verifyTicket } from "./ticket.js";

export interface PlaceHostOptions extends PlaceServerOptions {
  port: number;
  placeId: string;
  /** Shared with the portal, for verifying join tickets. */
  ticketSecret?: string;
  /** Allows guests when no ticket is presented. */
  allowGuests?: boolean;
}

/** Largest message a client may send, to stop one connection eating memory. */
const MAX_MESSAGE_BYTES = 256 * 1024;

/**
 * WebSocket front end for a PlaceServer. One of these runs per game-server
 * process; the portal supervises it.
 */
export class PlaceHost {
  readonly place: PlaceServer;
  private readonly http: Server;
  private readonly wss: WebSocketServer;
  private nextConnectionId = 1;
  private sockets = new Set<WebSocket>();

  constructor(private readonly opts: PlaceHostOptions) {
    this.place = new PlaceServer(opts);
    this.http = createServer((req, res) => {
      // A tiny health endpoint so the portal can tell a live server from a hung one.
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            placeId: opts.placeId,
            players: this.place.playerCount,
            protocol: PROTOCOL_VERSION,
          }),
        );
        return;
      }
      res.writeHead(404).end();
    });
    this.wss = new WebSocketServer({ server: this.http, maxPayload: MAX_MESSAGE_BYTES });
    this.wss.on("connection", (socket) => this.onConnection(socket));
  }

  async listen(): Promise<number> {
    this.place.start();
    await new Promise<void>((resolve) => this.http.listen(this.opts.port, resolve));
    const address = this.http.address();
    return typeof address === "object" && address ? address.port : this.opts.port;
  }

  async close(): Promise<void> {
    this.place.stop();
    for (const socket of this.sockets) socket.close(1001, "Server shutting down");
    this.sockets.clear();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  private onConnection(socket: WebSocket): void {
    const id = `c${this.nextConnectionId++}`;
    this.sockets.add(socket);
    let joined = false;
    let alive = true;

    const connection: Connection = {
      id,
      send(message: ServerMessage) {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
      },
      close(reason: string) {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({ t: "kick", reason } satisfies ServerMessage));
        }
        socket.close(1000, reason.slice(0, 120));
      },
    };

    socket.on("pong", () => {
      alive = true;
    });
    // Drops connections that have gone away without closing cleanly.
    const heartbeat = setInterval(() => {
      if (!alive) {
        socket.terminate();
        return;
      }
      alive = false;
      socket.ping();
    }, 15000);

    socket.on("message", (raw) => {
      let message: ClientMessage;
      try {
        message = JSON.parse(String(raw)) as ClientMessage;
      } catch {
        connection.close("Malformed message");
        return;
      }
      if (!message || typeof message.t !== "string") {
        connection.close("Malformed message");
        return;
      }

      if (!joined) {
        if (message.t !== "join") {
          connection.close("Expected a join message first");
          return;
        }
        const identity = this.resolveIdentity(message, connection);
        if (identity === null) return; // resolveIdentity already closed it.
        joined = this.place.join(connection, message, identity) !== null;
        return;
      }
      if (message.t === "join") return; // Joining twice is meaningless.

      try {
        this.place.handleMessage(id, message);
      } catch (err) {
        console.error(`[place] error handling ${message.t}:`, err);
      }
    });

    const cleanUp = () => {
      clearInterval(heartbeat);
      this.sockets.delete(socket);
      if (joined) this.place.leave(id);
    };
    socket.on("close", cleanUp);
    socket.on("error", cleanUp);
  }

  /**
   * Resolves who is connecting. Returns undefined for a guest, or null when the
   * connection has been refused (in which case it is already closed).
   */
  private resolveIdentity(
    message: Extract<ClientMessage, { t: "join" }>,
    connection: Connection,
  ): { accountId: string; username: string; avatar?: Record<string, unknown> } | undefined | null {
    const secret = this.opts.ticketSecret;
    if (!message.session) {
      if (this.opts.allowGuests !== false) return undefined;
      connection.close("This server requires you to sign in");
      return null;
    }
    if (!secret) {
      // Without a shared secret a ticket cannot be checked, and an unchecked
      // ticket is worse than none: treat the player as a guest instead.
      return undefined;
    }
    try {
      const ticket = verifyTicket(message.session, secret, this.opts.placeId);
      return {
        accountId: ticket.accountId,
        username: ticket.username,
        avatar: ticket.avatar,
      };
    } catch (err) {
      connection.close(err instanceof TicketError ? err.message : "Could not verify your session");
      return null;
    }
  }
}
