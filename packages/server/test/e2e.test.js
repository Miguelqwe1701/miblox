import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { PROTOCOL_VERSION } from "@miblox/core";
import { ServerManager } from "../dist/portal/manager.js";
import { PortalServer } from "../dist/portal/http.js";
import { buildStarterPlace } from "../dist/tools/build-place.js";
import { newTicket, verifyTicket, signTicket } from "../dist/place/ticket.js";

const TICKET_SECRET = "e2e-ticket-secret-value";

/** Boots a portal with the starter place registered, on an ephemeral port. */
async function bootPortal() {
  const dir = await mkdtemp(join(tmpdir(), "miblox-e2e-"));
  const placeFile = join(dir, "baseplate.json");
  await writeFile(placeFile, JSON.stringify(buildStarterPlace()), "utf8");

  const manager = new ServerManager({
    ticketSecret: TICKET_SECRET,
    basePort: 7300 + Math.floor(Math.random() * 400),
    log: () => {},
  });
  manager.registerGame({
    id: "baseplate",
    name: "Baseplate",
    description: "Test place",
    placeFile,
    maxPlayers: 8,
  });

  const portal = new PortalServer({
    port: 0,
    manager,
    ticketSecret: TICKET_SECRET,
    log: () => {},
  });
  const port = await portal.listen();
  return { portal, manager, port, base: `http://localhost:${port}` };
}

/** Connects, joins, and collects messages until `done` returns true. */
function connectAndJoin(port, join, { until, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://localhost:${port}`);
    const messages = [];
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`timed out; got ${messages.map((m) => m.t).join(", ") || "nothing"}`));
    }, timeoutMs);

    socket.on("open", () => socket.send(JSON.stringify(join)));
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      messages.push(message);
      if (until(message, messages)) {
        clearTimeout(timer);
        resolve({ socket, messages });
      }
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.on("close", () => {
      clearTimeout(timer);
      // Resolve rather than reject so kick tests can inspect what arrived.
      resolve({ socket, messages, closed: true });
    });
  });
}

test("the portal lists games over HTTP", async (t) => {
  const { portal, base } = await bootPortal();
  t.after(() => portal.close());

  const res = await fetch(`${base}/api/games`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.games.length, 1);
  assert.equal(body.games[0].id, "baseplate");
  assert.equal(body.servers.length, 0, "no server should run before anyone joins");
});

test("joining launches a game server process and returns a ticket", async (t) => {
  const { portal, manager, base } = await bootPortal();
  t.after(() => portal.close());

  const res = await fetch(`${base}/api/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ gameId: "baseplate" }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.port > 0, "a game server port should be returned");
  assert.ok(body.ticket, "a ticket should be issued");
  assert.equal(body.guest, true, "no sign-in configured, so this is a guest");

  // The ticket really is for this server and no other.
  const ticket = verifyTicket(body.ticket, TICKET_SECRET, body.serverId);
  assert.equal(ticket.username, "Guest");
  assert.throws(() => verifyTicket(body.ticket, TICKET_SECRET, "another-place"), /different place/);

  const servers = manager.listServers();
  assert.equal(servers.length, 1);
  assert.equal(servers[0].status, "running");
});

test("a second join reuses the running server rather than launching another", async (t) => {
  const { portal, manager, base } = await bootPortal();
  t.after(() => portal.close());

  const join = () =>
    fetch(`${base}/api/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gameId: "baseplate" }),
    }).then((r) => r.json());

  const first = await join();
  const second = await join();
  assert.equal(first.serverId, second.serverId);
  assert.equal(manager.listServers().length, 1);
});

test("joining an unknown game fails cleanly", async (t) => {
  const { portal, base } = await bootPortal();
  t.after(() => portal.close());
  const res = await fetch(`${base}/api/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ gameId: "nope" }),
  });
  assert.equal(res.status, 503);
});

test("a client connects, joins, and receives the world", async (t) => {
  const { portal, base } = await bootPortal();
  t.after(() => portal.close());

  const info = await fetch(`${base}/api/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ gameId: "baseplate" }),
  }).then((r) => r.json());

  const { socket, messages } = await connectAndJoin(
    info.port,
    {
      t: "join",
      name: "Tester",
      platform: "Desktop",
      protocol: PROTOCOL_VERSION,
      session: info.ticket,
    },
    { until: (m) => m.t === "delta" },
  );
  t.after(() => socket.close());

  const hello = messages.find((m) => m.t === "hello");
  assert.ok(hello, "expected a hello message");
  assert.equal(hello.protocol, PROTOCOL_VERSION);
  assert.equal(hello.placeName, "Baseplate");
  assert.equal(hello.username, "Guest");
  assert.equal(hello.serverAuthoritative, false);
  assert.equal(hello.terrain.seed, 20250915);

  const delta = messages.find((m) => m.t === "delta");
  assert.ok(delta?.delta.add?.length > 10, "the snapshot should carry the world");

  const names = delta.delta.add.map((i) => i.n);
  assert.ok(names.includes("Baseplate"), "the baseplate should replicate");
  assert.ok(names.includes("SpawnLocation"));
  assert.ok(names.includes("Terrain"));
});

test("the server's startup scripts actually ran", async (t) => {
  const { portal, base } = await bootPortal();
  t.after(() => portal.close());

  const info = await fetch(`${base}/api/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ gameId: "baseplate" }),
  }).then((r) => r.json());

  const { socket, messages } = await connectAndJoin(
    info.port,
    { t: "join", name: "Tester", platform: "Desktop", protocol: PROTOCOL_VERSION, session: info.ticket },
    { until: (m) => m.t === "delta" },
  );
  t.after(() => socket.close());

  const delta = messages.find((m) => m.t === "delta");
  const names = delta.delta.add.map((i) => i.n);
  // The starter script builds a tower and a Paint remote at startup.
  assert.ok(names.includes("Tower"), "the server script should have built the tower");
  assert.ok(names.includes("Block1"));
  assert.ok(names.includes("Paint"), "the RemoteEvent should exist");
});

test("a character is spawned and owned by the joining player", async (t) => {
  const { portal, base } = await bootPortal();
  t.after(() => portal.close());

  const info = await fetch(`${base}/api/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ gameId: "baseplate" }),
  }).then((r) => r.json());

  const { socket, messages } = await connectAndJoin(
    info.port,
    { t: "join", name: "Tester", platform: "Desktop", protocol: PROTOCOL_VERSION, session: info.ticket },
    {
      until: (m, all) =>
        all.some((msg) =>
          msg.t === "delta" && msg.delta.add?.some((i) => i.n === "HumanoidRootPart"),
        ),
    },
  );
  t.after(() => socket.close());

  const root = messages
    .filter((m) => m.t === "delta")
    .flatMap((m) => m.delta.add ?? [])
    .find((i) => i.n === "HumanoidRootPart");
  assert.ok(root, "the character root should replicate");
  const hello = messages.find((m) => m.t === "hello");
  assert.equal(
    root.props.NetworkOwnerId,
    hello.playerId,
    "the player should own their own character when Server Auth is off",
  );
});

test("terrain chunks stream to the client", async (t) => {
  const { portal, base } = await bootPortal();
  t.after(() => portal.close());

  const info = await fetch(`${base}/api/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ gameId: "baseplate" }),
  }).then((r) => r.json());

  const { socket, messages } = await connectAndJoin(
    info.port,
    { t: "join", name: "Tester", platform: "Desktop", protocol: PROTOCOL_VERSION, session: info.ticket },
    { until: (m) => m.t === "chunks" },
  );
  t.after(() => socket.close());

  const chunks = messages.find((m) => m.t === "chunks");
  assert.ok(chunks.chunks.length > 0);
  assert.match(chunks.chunks[0].key, /^-?\d+,-?\d+,-?\d+$/);
  assert.ok(chunks.chunks[0].rle.length > 0, "chunks should carry compressed voxels");
});

test("a forged ticket is refused", async (t) => {
  const { portal, base } = await bootPortal();
  t.after(() => portal.close());

  const info = await fetch(`${base}/api/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ gameId: "baseplate" }),
  }).then((r) => r.json());

  // Signed with the wrong key: the payload is plausible, the signature is not.
  const forged = signTicket(
    { accountId: "x", username: "Impostor", placeId: info.serverId, exp: Math.floor(Date.now() / 1000) + 60 },
    "not-the-real-secret",
  );

  const { messages } = await connectAndJoin(
    info.port,
    { t: "join", name: "Impostor", platform: "Desktop", protocol: PROTOCOL_VERSION, session: forged },
    { until: (m) => m.t === "kick" },
  );
  const kick = messages.find((m) => m.t === "kick");
  assert.ok(kick, "expected to be kicked");
  assert.match(kick.reason, /signature/i);
});

test("an expired ticket is refused", async (t) => {
  const { portal, base } = await bootPortal();
  t.after(() => portal.close());

  const info = await fetch(`${base}/api/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ gameId: "baseplate" }),
  }).then((r) => r.json());

  const expired = signTicket(
    { accountId: "x", username: "Stale", placeId: info.serverId, exp: Math.floor(Date.now() / 1000) - 10 },
    TICKET_SECRET,
  );
  const { messages } = await connectAndJoin(
    info.port,
    { t: "join", name: "Stale", platform: "Desktop", protocol: PROTOCOL_VERSION, session: expired },
    { until: (m) => m.t === "kick" },
  );
  assert.match(messages.find((m) => m.t === "kick").reason, /expired/i);
});

test("a protocol mismatch is reported rather than silently misbehaving", async (t) => {
  const { portal, base } = await bootPortal();
  t.after(() => portal.close());

  const info = await fetch(`${base}/api/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ gameId: "baseplate" }),
  }).then((r) => r.json());

  const { messages } = await connectAndJoin(
    info.port,
    { t: "join", name: "Old", platform: "Desktop", protocol: 999, session: info.ticket },
    { until: (m) => m.t === "kick" },
  );
  assert.match(messages.find((m) => m.t === "kick").reason, /Version mismatch/);
});

test("two players see each other", async (t) => {
  const { portal, base } = await bootPortal();
  t.after(() => portal.close());

  const joinInfo = () =>
    fetch(`${base}/api/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gameId: "baseplate" }),
    }).then((r) => r.json());

  const first = await joinInfo();
  const a = await connectAndJoin(
    first.port,
    { t: "join", name: "Alice", platform: "Desktop", protocol: PROTOCOL_VERSION, session: first.ticket },
    { until: (m) => m.t === "delta" },
  );
  t.after(() => a.socket.close());

  // Alice keeps collecting; Bob joining should reach her as a delta.
  const sawBob = new Promise((resolve) => {
    a.socket.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (message.t !== "delta") return;
      if (message.delta.add?.some((i) => i.cn === "Player")) resolve(true);
    });
  });

  const second = await joinInfo();
  const b = await connectAndJoin(
    second.port,
    { t: "join", name: "Bob", platform: "Desktop", protocol: PROTOCOL_VERSION, session: second.ticket },
    { until: (m) => m.t === "delta" },
  );
  t.after(() => b.socket.close());

  assert.equal(await sawBob, true, "Alice should be told about Bob");
});

test("the health endpoint reports the running place", async (t) => {
  const { portal, base } = await bootPortal();
  t.after(() => portal.close());
  const info = await fetch(`${base}/api/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ gameId: "baseplate" }),
  }).then((r) => r.json());

  const health = await fetch(`http://localhost:${info.port}/health`).then((r) => r.json());
  assert.equal(health.ok, true);
  assert.equal(health.protocol, PROTOCOL_VERSION);
});

test("stopping the portal shuts its game servers down", async () => {
  const { portal, manager, base } = await bootPortal();
  await fetch(`${base}/api/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ gameId: "baseplate" }),
  });
  assert.equal(manager.listServers().length, 1);
  await portal.close();
  assert.equal(manager.listServers().length, 0, "no orphaned game-server processes");
});
