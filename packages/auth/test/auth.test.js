import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  AuthService,
  AuthError,
  MemoryAccountStore,
  MigoodClient,
  MigoodError,
  UsernameError,
  suggestUsername,
  validateUsername,
  newState,
} from "../dist/index.js";

const SECRET = "test-session-secret-at-least-16";

/** A stand-in for Migood's API so the tests never touch the network. */
function stubMigood(handlers = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, body, url, headers: init.headers });
    const handler = handlers[path];
    if (!handler) return new Response("not found", { status: 404 });
    const result = await handler(body, new URL(url), init);
    if (result instanceof Response) return result;
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetchImpl, calls };
}

function makeService(handlers, opts = {}) {
  const { fetchImpl, calls } = stubMigood(handlers);
  const client = new MigoodClient({
    clientId: "cid",
    clientSecret: "csecret",
    webhookSecret: opts.webhookSecret,
    fetchImpl,
  });
  const store = new MemoryAccountStore();
  const auth = new AuthService({ client, store, sessionSecret: SECRET });
  return { auth, store, client, calls };
}

const SEND_INFO_OK = {
  verified: true,
  id: 12,
  username: "someone",
  displayName: "Someone",
  avatar: "/cdn/pfps/someone.png",
  scopes: ["identity", "multiplayer"],
  issuedAt: 1787000000,
  expiresAt: 1787043200,
};

test("the SDK game-token flow creates a linked account", async () => {
  const { auth, calls } = makeService({ "/api/sendinfo": () => SEND_INFO_OK });
  const result = await auth.loginWithGameToken("game-token");

  assert.equal(result.created, true);
  assert.equal(result.account.link.userId, 12);
  assert.equal(result.account.link.username, "someone");
  assert.equal(result.account.username, "someone");
  // The client secret must go to Migood, never anywhere else.
  assert.equal(calls[0].body.clientSecret, "csecret");
  assert.equal(calls[0].body.token, "game-token");
});

test("a second login reuses the same account", async () => {
  const { auth } = makeService({ "/api/sendinfo": () => SEND_INFO_OK });
  const first = await auth.loginWithGameToken("t1");
  const second = await auth.loginWithGameToken("t2");
  assert.equal(second.created, false);
  assert.equal(second.account.id, first.account.id);
});

test("a Migood rename keeps the same MiBlox account", async () => {
  let info = { ...SEND_INFO_OK };
  const { auth } = makeService({ "/api/sendinfo": () => info });
  const first = await auth.loginWithGameToken("t1");
  // Same numeric id, brand new Migood username.
  info = { ...SEND_INFO_OK, username: "renamed", displayName: "Renamed" };
  const second = await auth.loginWithGameToken("t2");

  assert.equal(second.account.id, first.account.id, "the link must survive a rename");
  assert.equal(second.account.link.username, "renamed");
  // Our own username is ours, so a Migood rename must not change it.
  assert.equal(second.account.username, "someone");
});

test("an unverified token is rejected", async () => {
  const { auth } = makeService({ "/api/sendinfo": () => ({ verified: false }) });
  await assert.rejects(() => auth.loginWithGameToken("bad"), AuthError);
});

test("API errors carry the status and a readable reason", async () => {
  const { auth } = makeService({
    "/api/sendinfo": () => new Response("nope", { status: 401 }),
  });
  await assert.rejects(
    () => auth.loginWithGameToken("bad"),
    (err) => err instanceof MigoodError && err.status === 401 && /expired token/.test(err.message),
  );
});

test("the authorization-code flow logs in via userinfo", async () => {
  const { auth, calls } = makeService({
    "/oauth/token": () => ({
      access_token: "at",
      refresh_token: "rt",
      token_type: "Bearer",
      expires_in: 5184000,
      scope: "identify",
    }),
    "/api/oauth/userinfo": () => ({
      username: "coder",
      displayName: "Coder",
      avatar: "/cdn/pfps/coder.png",
    }),
  });
  const result = await auth.loginWithAuthCode("AUTH_CODE", "https://miblox.example/callback");
  assert.equal(result.account.username, "coder");
  // No numeric id is available on this path, so the link starts weak.
  assert.equal(result.account.link.userId, undefined);
  assert.equal(calls[1].headers.Authorization, "Bearer at");
});

test("the numeric id is backfilled when the SDK flow is used later", async () => {
  const { auth } = makeService({
    "/oauth/token": () => ({
      access_token: "at",
      refresh_token: "rt",
      token_type: "Bearer",
      expires_in: 1,
      scope: "identify",
    }),
    "/api/oauth/userinfo": () => ({
      username: "someone",
      displayName: "Someone",
      avatar: "/a.png",
    }),
    "/api/sendinfo": () => SEND_INFO_OK,
  });
  const viaCode = await auth.loginWithAuthCode("c", "https://miblox.example/cb");
  assert.equal(viaCode.account.link.userId, undefined);

  const viaSdk = await auth.loginWithGameToken("t");
  assert.equal(viaSdk.created, false, "should match the existing weak link");
  assert.equal(viaSdk.account.id, viaCode.account.id);
  assert.equal(viaSdk.account.link.userId, 12, "the id should now be recorded");
});

test("authorizeUrl carries client id, scopes and state", () => {
  const { auth } = makeService({});
  const state = newState();
  const url = new URL(auth.authorizeUrl("https://miblox.example/cb", state, ["identify"]));
  assert.equal(url.searchParams.get("client_id"), "cid");
  assert.equal(url.searchParams.get("state"), state);
  assert.equal(url.searchParams.get("scope"), "identify");
  assert.ok(!url.search.includes("csecret"), "the secret must never be in a browser URL");
});

test("device-code login reports pending, then succeeds", async () => {
  let status = { status: "pending" };
  const { auth } = makeService({
    "/api/oauth/device/init": () => ({
      user_code: "384021",
      device_code: "opaque",
      expires_in: 600,
    }),
    "/api/oauth/device/poll": () => status,
    "/oauth/token": (body) => {
      assert.equal(body.redirect_uri, "devicecode");
      return {
        access_token: "at",
        refresh_token: "rt",
        token_type: "Bearer",
        expires_in: 1,
        scope: "identify",
      };
    },
    "/api/oauth/userinfo": () => ({
      username: "vrplayer",
      displayName: "VR Player",
      avatar: "/a.png",
    }),
  });

  const init = await auth.startDeviceLogin(["identify"]);
  assert.equal(init.user_code, "384021");
  await assert.rejects(
    () => auth.completeDeviceLogin(init.device_code),
    (err) => err.code === "pending",
  );

  status = { status: "approved", code: "AUTH_CODE" };
  const result = await auth.completeDeviceLogin(init.device_code);
  assert.equal(result.account.username, "vrplayer");
});

test("a denied device code is reported as denied", async () => {
  const { auth } = makeService({
    "/api/oauth/device/poll": () => ({ status: "denied" }),
  });
  await assert.rejects(
    () => auth.completeDeviceLogin("dc"),
    (err) => err.code === "denied",
  );
});

test("a webhook with a valid signature logs the player in", async () => {
  const webhookSecret = "hook-secret";
  const { auth } = makeService(
    {
      "/oauth/token": (body) => {
        assert.equal(body.redirect_uri, "builtinoauth");
        return {
          access_token: "at",
          refresh_token: "rt",
          token_type: "Bearer",
          expires_in: 1,
          scope: "identify",
        };
      },
      "/api/oauth/userinfo": () => ({
        username: "webhooked",
        displayName: "Webhooked",
        avatar: "/a.png",
      }),
    },
    { webhookSecret },
  );

  const body = JSON.stringify({
    event: "oauth_verified",
    code: "AUTH_CODE",
    state: "player-42",
    clientId: "cid",
    username: "webhooked",
    scopes: ["identify"],
  });
  const signature = createHmac("sha256", webhookSecret).update(body, "utf8").digest("hex");

  const { state, login } = await auth.handleVerificationWebhook(body, signature);
  assert.equal(state, "player-42");
  assert.equal(login.account.username, "webhooked");
});

test("a forged webhook signature is rejected before the body is trusted", async () => {
  const { auth, calls } = makeService({}, { webhookSecret: "hook-secret" });
  const body = JSON.stringify({ event: "oauth_verified", code: "x", state: "s", clientId: "cid" });
  await assert.rejects(
    () => auth.handleVerificationWebhook(body, "00".repeat(32)),
    (err) => err.code === "bad_signature",
  );
  assert.equal(calls.length, 0, "a forged webhook must not trigger a token exchange");
});

test("a webhook for another app is rejected", async () => {
  const webhookSecret = "hook-secret";
  const { auth } = makeService({}, { webhookSecret });
  const body = JSON.stringify({
    event: "oauth_verified",
    code: "x",
    state: "s",
    clientId: "someone-elses-app",
  });
  const signature = createHmac("sha256", webhookSecret).update(body, "utf8").digest("hex");
  await assert.rejects(() => auth.handleVerificationWebhook(body, signature), AuthError);
});

test("sessions round-trip and reject tampering", async () => {
  const { auth } = makeService({ "/api/sendinfo": () => SEND_INFO_OK });
  const { account, session } = await auth.loginWithGameToken("t");
  const verified = await auth.verifySession(session);
  assert.equal(verified.id, account.id);

  const [body, sig] = session.split(".");
  await assert.rejects(() => auth.verifySession(`${body}x.${sig}`), AuthError);
  await assert.rejects(() => auth.verifySession("garbage"), AuthError);
});

test("an expired session is rejected", async () => {
  const { fetchImpl } = stubMigood({ "/api/sendinfo": () => SEND_INFO_OK });
  const client = new MigoodClient({ clientId: "cid", clientSecret: "cs", fetchImpl });
  const store = new MemoryAccountStore();
  const auth = new AuthService({
    client,
    store,
    sessionSecret: SECRET,
    sessionTtlSeconds: -1,
  });
  const { session } = await auth.loginWithGameToken("t");
  await assert.rejects(
    () => auth.verifySession(session),
    (err) => err.code === "expired",
  );
});

test("a banned account cannot log in or use an old session", async () => {
  const { auth, store } = makeService({ "/api/sendinfo": () => SEND_INFO_OK });
  const { account, session } = await auth.loginWithGameToken("t");
  account.banned = { reason: "griefing" };
  await store.put(account);

  await assert.rejects(
    () => auth.verifySession(session),
    (err) => err.code === "banned",
  );
  await assert.rejects(
    () => auth.loginWithGameToken("t"),
    (err) => err.code === "banned",
  );
});

test("players can change their username at any time", async () => {
  const { auth } = makeService({ "/api/sendinfo": () => SEND_INFO_OK });
  const { account } = await auth.loginWithGameToken("t");
  const renamed = await auth.setUsername(account.id, "BlockBuilder");
  assert.equal(renamed.username, "BlockBuilder");
  // The Migood link is untouched by a MiBlox rename.
  assert.equal(renamed.link.username, "someone");
  const again = await auth.setUsername(account.id, "BlockBuilder");
  assert.equal(again.username, "BlockBuilder", "renaming to your own name is a no-op");
});

test("usernames are validated and unique", async () => {
  const { auth, store } = makeService({ "/api/sendinfo": () => SEND_INFO_OK });
  const { account } = await auth.loginWithGameToken("t");

  await assert.rejects(() => auth.setUsername(account.id, "ab"), UsernameError);
  await assert.rejects(() => auth.setUsername(account.id, "has spaces"), UsernameError);
  await assert.rejects(() => auth.setUsername(account.id, "admin"), UsernameError);

  await store.put({
    id: "other",
    username: "Taken",
    usernameLower: "taken",
    link: { username: "other", displayName: "Other", scopes: [], linkedAt: 0 },
    createdAt: 0,
    lastSeenAt: 0,
  });
  await assert.rejects(() => auth.setUsername(account.id, "taken"), UsernameError);
});

test("suggestUsername avoids collisions and invalid names", async () => {
  const store = new MemoryAccountStore();
  await store.put({
    id: "a",
    username: "player",
    usernameLower: "player",
    link: { username: "player", displayName: "", scopes: [], linkedAt: 0 },
    createdAt: 0,
    lastSeenAt: 0,
  });
  assert.equal(await suggestUsername("player", store), "player2");
  // Too short to be a valid username, so it gets a prefix.
  assert.equal(await suggestUsername("a b!", store), "playerab");
  validateUsername(await suggestUsername("x", store));

  // A name already at the 20-char limit must be truncated to fit its suffix.
  const long = "abcdefghijklmnopqrst";
  await store.put({
    id: "b",
    username: long,
    usernameLower: long,
    link: { username: long, displayName: "", scopes: [], linkedAt: 0 },
    createdAt: 0,
    lastSeenAt: 0,
  });
  const suggested = await suggestUsername(long, store);
  assert.equal(suggested, "abcdefghijklmnopqrs2");
  assert.equal(suggested.length, 20);
  validateUsername(suggested);
});
