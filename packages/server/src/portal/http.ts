import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import {
  AuthError,
  AuthService,
  UsernameError,
  newState,
  type Account,
} from "@miblox/auth";
import {
  BUILTIN_ASSETS,
  DEFAULT_DESCRIPTION,
  TEMPLATE_DESCRIPTION,
  validateDescription,
  type SerializedPlace,
} from "@miblox/core";
import { ServerManager, type GameDefinition } from "./manager.js";
import { newTicket } from "../place/ticket.js";

export interface PortalOptions {
  port: number;
  manager: ServerManager;
  ticketSecret: string;
  /** Absent when no Migood credentials are configured: everyone is a guest. */
  auth?: AuthService;
  /** Directory containing the built client, served at the site root. */
  clientDir?: string;
  /** Public host clients should connect to for game servers. */
  publicHost?: string;
  /** Base URL of this portal, for OAuth redirects. */
  publicUrl?: string;
  log?: (message: string) => void;
}

const SESSION_COOKIE = "miblox_session";
/** OAuth `state` values we have issued, so a callback can be checked. */
const PENDING_STATES = new Map<string, number>();
const STATE_TTL_MS = 10 * 60 * 1000;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

/**
 * The website and API.
 *
 * This process holds the Migood client secret and is the only one that talks
 * to Migood. It hands players a short-lived signed ticket, then points them at
 * a game-server process it launched for the place they picked.
 */
export class PortalServer {
  private readonly http: Server;
  private readonly log: (message: string) => void;

  constructor(private readonly opts: PortalOptions) {
    this.log = opts.log ?? ((m) => console.log(`[portal] ${m}`));
    this.http = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        this.log(`request failed: ${String(err)}`);
        if (!res.headersSent) sendJson(res, 500, { error: "Internal error" });
        else res.end();
      });
    });
  }

  async listen(): Promise<number> {
    this.opts.manager.start();
    await new Promise<void>((resolve) => this.http.listen(this.opts.port, resolve));
    const address = this.http.address();
    const port = typeof address === "object" && address ? address.port : this.opts.port;
    this.log(`listening on http://localhost:${port}`);
    if (!this.opts.auth) {
      this.log("no Migood credentials configured, so everyone plays as a guest");
    }
    return port;
  }

  async close(): Promise<void> {
    await this.opts.manager.stopAll();
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;
    const method = req.method ?? "GET";

    // -- API ---------------------------------------------------------------
    if (path === "/api/games" && method === "GET") {
      return sendJson(res, 200, {
        games: this.opts.manager.listGames().map(publicGame),
        servers: this.opts.manager.listServers(),
      });
    }

    if (path === "/api/me" && method === "GET") {
      const account = await this.currentAccount(req);
      return sendJson(res, 200, { account: account ? publicAccount(account) : null });
    }

    if (path === "/api/me/username" && method === "POST") {
      return this.renameAccount(req, res);
    }

    if (path === "/api/join" && method === "POST") {
      return this.join(req, res);
    }

    // -- avatars and assets -------------------------------------------------
    if (path === "/api/assets" && method === "GET") {
      // The whole catalogue in one response: it is small, and the avatar
      // editor and the Studio plugins all want the same list.
      return sendJson(res, 200, { assets: BUILTIN_ASSETS });
    }

    if (path === "/api/avatars" && method === "GET") {
      return this.listAvatars(res);
    }
    if (path.startsWith("/api/avatars/") && method === "GET") {
      return this.readAvatar(decodeURIComponent(path.slice("/api/avatars/".length)), res);
    }
    if (path === "/api/me/avatar" && method === "PUT") {
      return this.writeOwnAvatar(req, res);
    }

    // -- studio ------------------------------------------------------------
    if (path.startsWith("/api/places/")) {
      const id = decodeURIComponent(path.slice("/api/places/".length));
      if (method === "GET") return this.readPlace(id, res);
      if (method === "PUT") return this.writePlace(id, req, res);
    }

    // -- auth --------------------------------------------------------------
    if (path === "/auth/login" && method === "GET") {
      return this.beginLogin(res, url);
    }
    if (path === "/auth/callback" && method === "GET") {
      return this.completeLogin(res, url);
    }
    if (path === "/auth/sdk" && method === "POST") {
      return this.loginWithSdkToken(req, res);
    }
    if (path === "/auth/device/start" && method === "POST") {
      return this.startDeviceLogin(req, res);
    }
    if (path === "/auth/device/poll" && method === "POST") {
      return this.pollDeviceLogin(req, res);
    }
    if (path === "/auth/webhook" && method === "POST") {
      return this.handleWebhook(req, res);
    }
    if (path === "/auth/logout" && method === "POST") {
      res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
      return sendJson(res, 200, { ok: true });
    }

    // -- static ------------------------------------------------------------
    if (method === "GET" || method === "HEAD") {
      // These are client-side routes; serve the app and let it read the id.
      const filePath = path.startsWith("/play/")
        ? "/index.html"
        : path.startsWith("/studio/")
          ? "/studio.html"
          : path;
      if (await this.serveStatic(filePath, res)) return;
      if (path === "/" || path.startsWith("/play/") || path.startsWith("/studio/")) {
        return sendHtml(res, 200, fallbackPage(this.opts.manager.listGames()));
      }
    }

    sendJson(res, 404, { error: "Not found" });
  }

  // -- auth handlers -------------------------------------------------------

  private beginLogin(res: ServerResponse, url: URL): void {
    const auth = this.opts.auth;
    if (!auth) return sendJson(res, 503, { error: "Sign-in is not configured on this server" });

    pruneStates();
    const state = newState();
    PENDING_STATES.set(state, Date.now());
    const redirectUri = this.redirectUri(url);
    res.writeHead(302, { Location: auth.authorizeUrl(redirectUri, state, ["identify"]) });
    res.end();
  }

  private async completeLogin(res: ServerResponse, url: URL): Promise<void> {
    const auth = this.opts.auth;
    if (!auth) return sendJson(res, 503, { error: "Sign-in is not configured on this server" });

    const error = url.searchParams.get("error");
    if (error) return sendHtml(res, 400, messagePage("Sign-in cancelled", `Migood said: ${escapeHtml(error)}`));

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    // The state check is the only thing standing between this and CSRF.
    if (!code || !state || !PENDING_STATES.delete(state)) {
      return sendHtml(res, 400, messagePage("Sign-in failed", "That sign-in link was not valid or has expired."));
    }

    try {
      const result = await auth.loginWithAuthCode(code, this.redirectUri(url));
      this.log(`${result.account.username} signed in${result.created ? " for the first time" : ""}`);
      res.writeHead(302, {
        Location: "/",
        "Set-Cookie": sessionCookie(result.session),
      });
      res.end();
    } catch (err) {
      this.log(`sign-in failed: ${String(err)}`);
      sendHtml(res, 400, messagePage("Sign-in failed", "Migood could not verify that sign-in."));
    }
  }

  /** In-frame SDK path: the game posts its Migood token, we verify it. */
  private async loginWithSdkToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = this.opts.auth;
    if (!auth) return sendJson(res, 503, { error: "Sign-in is not configured on this server" });
    const body = await readJson<{ token?: string }>(req);
    if (!body?.token) return sendJson(res, 400, { error: "A token is required" });
    try {
      const result = await auth.loginWithGameToken(body.token);
      res.setHeader("Set-Cookie", sessionCookie(result.session));
      sendJson(res, 200, {
        account: publicAccount(result.account),
        session: result.session,
        created: result.created,
      });
    } catch (err) {
      sendJson(res, 401, { error: describeAuthError(err) });
    }
  }

  private async startDeviceLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = this.opts.auth;
    if (!auth) return sendJson(res, 503, { error: "Sign-in is not configured on this server" });
    try {
      const init = await auth.startDeviceLogin(["identify"]);
      // device_code stays between this server and Migood; only the short code
      // is meant for the player to read out.
      sendJson(res, 200, {
        userCode: init.user_code,
        deviceCode: init.device_code,
        expiresIn: init.expires_in,
        instructions: "Open Migood Games, then your profile menu, then Enter Code.",
      });
    } catch (err) {
      sendJson(res, 502, { error: describeAuthError(err) });
    }
  }

  private async pollDeviceLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = this.opts.auth;
    if (!auth) return sendJson(res, 503, { error: "Sign-in is not configured on this server" });
    const body = await readJson<{ deviceCode?: string }>(req);
    if (!body?.deviceCode) return sendJson(res, 400, { error: "A deviceCode is required" });
    try {
      const result = await auth.completeDeviceLogin(body.deviceCode);
      res.setHeader("Set-Cookie", sessionCookie(result.session));
      sendJson(res, 200, {
        status: "approved",
        account: publicAccount(result.account),
        session: result.session,
      });
    } catch (err) {
      if (err instanceof AuthError && err.code === "pending") {
        return sendJson(res, 200, { status: "pending" });
      }
      if (err instanceof AuthError && (err.code === "denied" || err.code === "expired")) {
        return sendJson(res, 200, { status: err.code });
      }
      sendJson(res, 502, { error: describeAuthError(err) });
    }
  }

  private async handleWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = this.opts.auth;
    if (!auth) return sendJson(res, 503, { error: "Sign-in is not configured on this server" });
    // The signature covers the raw bytes, so this must not be parsed first.
    const raw = await readBody(req);
    const signature = String(req.headers["x-migood-signature"] ?? "");
    try {
      const { state, login } = await auth.handleVerificationWebhook(raw, signature);
      this.log(`webhook verified ${login.account.username} for state ${state}`);
      // Migood requires a 2xx before it tells the player it worked.
      sendJson(res, 200, { ok: true });
    } catch (err) {
      this.log(`webhook rejected: ${String(err)}`);
      sendJson(res, 401, { error: "Could not verify that webhook" });
    }
  }

  // -- account and join ----------------------------------------------------

  private async currentAccount(req: IncomingMessage): Promise<Account | null> {
    const auth = this.opts.auth;
    if (!auth) return null;
    const token = readCookie(req, SESSION_COOKIE);
    if (!token) return null;
    try {
      return await auth.verifySession(token);
    } catch {
      return null;
    }
  }

  private async renameAccount(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = this.opts.auth;
    if (!auth) return sendJson(res, 503, { error: "Sign-in is not configured on this server" });
    const account = await this.currentAccount(req);
    if (!account) return sendJson(res, 401, { error: "Sign in first" });
    const body = await readJson<{ username?: string }>(req);
    if (!body?.username) return sendJson(res, 400, { error: "A username is required" });
    try {
      const updated = await auth.setUsername(account.id, body.username);
      sendJson(res, 200, { account: publicAccount(updated) });
    } catch (err) {
      if (err instanceof UsernameError) return sendJson(res, 400, { error: err.message });
      sendJson(res, 500, { error: "Could not change that username" });
    }
  }

  /**
   * Picks or launches a server for a game and issues a ticket for it.
   *
   * The ticket is what the place server trusts; it is signed with a secret the
   * two processes share, is valid for two minutes, and names one place.
   */
  private async join(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson<{ gameId?: string }>(req);
    if (!body?.gameId) return sendJson(res, 400, { error: "A gameId is required" });

    const account = await this.currentAccount(req);
    let server;
    try {
      server = await this.opts.manager.acquire(body.gameId);
    } catch (err) {
      this.log(`could not start ${body.gameId}: ${String(err)}`);
      return sendJson(res, 503, { error: "That game could not be started right now" });
    }

    const ticket = newTicket(
      {
        accountId: account?.id ?? "",
        username: account?.username ?? "Guest",
        placeId: server.id,
        avatar: (account?.avatar ?? DEFAULT_DESCRIPTION) as Record<string, unknown>,
      },
      this.opts.ticketSecret,
    );

    sendJson(res, 200, {
      host: this.opts.publicHost ?? "localhost",
      port: server.port,
      serverId: server.id,
      ticket,
      guest: !account,
      username: account?.username ?? null,
    });
  }

  // -- avatars -------------------------------------------------------------

  /**
   * The player directory the character adder browses.
   *
   * Only usernames, display names and looks: nothing here identifies the
   * Migood account behind a player, which is not any place's business.
   */
  private async listAvatars(res: ServerResponse): Promise<void> {
    const players = this.opts.auth
      ? (await this.opts.auth.allAccounts()).map((account) => ({
          username: account.username,
          displayName: account.link.displayName || account.username,
          avatar: account.avatar ?? DEFAULT_DESCRIPTION,
        }))
      : [];

    sendJson(res, 200, {
      // Always offered, so the adder works before anyone has signed up and
      // on a server with no sign-in configured at all.
      templates: [
        { username: "Template", displayName: "Template player", avatar: TEMPLATE_DESCRIPTION },
        { username: "Default", displayName: "Default avatar", avatar: DEFAULT_DESCRIPTION },
      ],
      players,
    });
  }

  private async readAvatar(username: string, res: ServerResponse): Promise<void> {
    if (username.toLowerCase() === "template") {
      return sendJson(res, 200, { username: "Template", avatar: TEMPLATE_DESCRIPTION });
    }
    if (username.toLowerCase() === "default") {
      return sendJson(res, 200, { username: "Default", avatar: DEFAULT_DESCRIPTION });
    }
    if (!this.opts.auth) return sendJson(res, 404, { error: "No such player" });

    const account = await this.opts.auth.findByUsername(username);
    if (!account) return sendJson(res, 404, { error: "No such player" });
    sendJson(res, 200, {
      username: account.username,
      displayName: account.link.displayName || account.username,
      avatar: account.avatar ?? DEFAULT_DESCRIPTION,
    });
  }

  private async writeOwnAvatar(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = this.opts.auth;
    if (!auth) return sendJson(res, 503, { error: "Sign-in is not configured on this server" });
    const account = await this.currentAccount(req);
    if (!account) return sendJson(res, 401, { error: "Sign in first" });

    const body = await readJson<{ avatar?: Record<string, unknown> }>(req);
    if (!body?.avatar || typeof body.avatar !== "object") {
      return sendJson(res, 400, { error: "An avatar description is required" });
    }
    // Checked here rather than trusted: a client could otherwise store a hat
    // id in the pants slot and every place would then build it wrong.
    const problems = validateDescription(body.avatar);
    if (problems.length) return sendJson(res, 400, { error: problems.join("; ") });

    const updated = await auth.setAvatar(account.id, body.avatar);
    sendJson(res, 200, { avatar: updated.avatar });
  }

  // -- studio: reading and writing places ----------------------------------

  private async readPlace(id: string, res: ServerResponse): Promise<void> {
    const game = this.opts.manager.getGame(id);
    if (!game) return sendJson(res, 404, { error: "No such world" });
    try {
      const raw = await readFile(game.placeFile, "utf8");
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(raw);
    } catch (err) {
      this.log(`could not read ${game.placeFile}: ${String(err)}`);
      sendJson(res, 500, { error: "Could not read that world" });
    }
  }

  /**
   * Saves an edited place.
   *
   * Written through a temp file and renamed, so a failed write cannot leave a
   * half-written world behind. Any running server for the place is stopped:
   * it holds the old world in memory, and players rejoining should get the new
   * one rather than a copy that no longer matches what is on disk.
   */
  private async writePlace(id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const game = this.opts.manager.getGame(id);
    if (!game) return sendJson(res, 404, { error: "No such world" });

    // Editing is gated on being signed in, when sign-in is configured at all.
    if (this.opts.auth) {
      const account = await this.currentAccount(req);
      if (!account) return sendJson(res, 401, { error: "Sign in to save changes" });
    }

    const raw = await readBody(req);
    let place: SerializedPlace;
    try {
      place = JSON.parse(raw) as SerializedPlace;
    } catch {
      return sendJson(res, 400, { error: "That is not valid JSON" });
    }
    if (place?.format !== "miblox-place") {
      return sendJson(res, 400, { error: "That is not a MiBlox place file" });
    }

    try {
      const tmp = `${game.placeFile}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(place, null, 2), "utf8");
      await rename(tmp, game.placeFile);
    } catch (err) {
      this.log(`could not write ${game.placeFile}: ${String(err)}`);
      return sendJson(res, 500, { error: "Could not save that world" });
    }

    // Reload the catalogue entry, since the name or limits may have changed.
    this.opts.manager.registerGame({
      ...game,
      name: place.name ?? game.name,
      description: (place as { description?: string }).description ?? game.description,
      maxPlayers: (place as { maxPlayers?: number }).maxPlayers ?? game.maxPlayers,
      serverAuthoritative:
        (place as { serverAuthoritative?: boolean }).serverAuthoritative ??
        game.serverAuthoritative,
    });

    const running = this.opts.manager.listServers().filter((s) => s.gameId === id);
    await Promise.all(running.map((s) => this.opts.manager.stop(s.id)));
    this.log(`saved ${id}${running.length ? ` and restarted ${running.length} server(s)` : ""}`);
    sendJson(res, 200, { ok: true, restarted: running.length });
  }

  // -- static files --------------------------------------------------------

  private async serveStatic(path: string, res: ServerResponse): Promise<boolean> {
    const dir = this.opts.clientDir;
    if (!dir) return false;
    const requested = path === "/" ? "/index.html" : path;
    // Resolve and confirm the result is still inside the client directory, so
    // a crafted path cannot read files elsewhere on the machine.
    const root = resolve(dir);
    const target = resolve(join(root, normalize(requested)));
    if (target !== root && !target.startsWith(root + sep)) return false;

    try {
      const info = await stat(target);
      if (!info.isFile()) return false;
      res.writeHead(200, {
        "Content-Type": MIME[extname(target)] ?? "application/octet-stream",
        "Content-Length": info.size,
        // Hashed bundles may be cached; index.html must not be.
        "Cache-Control": target.endsWith(".html") ? "no-cache" : "public, max-age=3600",
      });
      createReadStream(target).pipe(res);
      return true;
    } catch {
      return false;
    }
  }

  private redirectUri(url: URL): string {
    const base = this.opts.publicUrl ?? `${url.protocol}//${url.host}`;
    return `${base.replace(/\/$/, "")}/auth/callback`;
  }
}

// -- helpers ---------------------------------------------------------------

function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=43200; SameSite=Lax`;
}

function pruneStates(): void {
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const [state, issued] of PENDING_STATES) {
    if (issued < cutoff) PENDING_STATES.delete(state);
  }
}

function publicAccount(account: Account) {
  return {
    id: account.id,
    username: account.username,
    displayName: account.link.displayName,
    avatar: account.link.avatar,
    migoodUsername: account.link.username,
    createdAt: account.createdAt,
  };
}

function publicGame(game: GameDefinition) {
  return {
    id: game.id,
    name: game.name,
    description: game.description,
    maxPlayers: game.maxPlayers ?? 32,
    serverAuthoritative: game.serverAuthoritative ?? false,
    thumbnail: game.thumbnail,
  };
}

function describeAuthError(err: unknown): string {
  if (err instanceof AuthError) return err.message;
  return "Sign-in failed";
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
  });
  res.end(html);
}

const MAX_BODY_BYTES = 1024 * 1024;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) throw new Error("Request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson<T>(req: IncomingMessage): Promise<T | null> {
  const raw = await readBody(req);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function readCookie(req: IncomingMessage, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

function messagePage(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font:16px system-ui;margin:0;display:grid;place-items:center;height:100vh;background:#12151c;color:#e8ecf4}
.card{max-width:32rem;padding:2rem;background:#1a1f2b;border-radius:12px}a{color:#7cc4ff}</style></head>
<body><div class="card"><h1>${escapeHtml(title)}</h1><p>${body}</p><p><a href="/">Back to MiBlox</a></p></div></body></html>`;
}

/** Shown when the client bundle has not been built yet. */
function fallbackPage(games: GameDefinition[]): string {
  const list = games.length
    ? games
        .map(
          (g) =>
            `<li><strong>${escapeHtml(g.name)}</strong> - ${escapeHtml(g.description)}</li>`,
        )
        .join("")
    : "<li>No games are registered yet.</li>";
  return `<!doctype html><html><head><meta charset="utf-8"><title>MiBlox</title>
<style>body{font:16px system-ui;margin:0;display:grid;place-items:center;min-height:100vh;background:#12151c;color:#e8ecf4}
.card{max-width:40rem;padding:2rem;background:#1a1f2b;border-radius:12px}code{background:#0d1017;padding:.15em .4em;border-radius:4px}
ul{line-height:1.7}</style></head>
<body><div class="card"><h1>MiBlox</h1>
<p>The portal is running, but the client bundle has not been built yet. Run:</p>
<p><code>npm run build -w @miblox/client</code></p>
<h2>Registered games</h2><ul>${list}</ul></div></body></html>`;
}
