import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  type Account,
  type AccountStore,
  type MigoodLink,
  defaultAvatar,
  newAccountId,
  suggestUsername,
  UsernameError,
  validateUsername,
} from "./accounts.js";
import {
  MigoodClient,
  REDIRECT_BUILTIN,
  REDIRECT_DEVICE,
  type DeviceInitResult,
} from "./migood.js";

export interface SessionPayload {
  /** MiBlox account id. */
  sub: string;
  /** Username at issue time; refreshed from the account on every use. */
  name: string;
  iat: number;
  exp: number;
}

export interface LoginResult {
  account: Account;
  session: string;
  /** True the first time this Migood identity signed in. */
  created: boolean;
}

export interface AuthServiceOptions {
  client: MigoodClient;
  store: AccountStore;
  /** Signs our own session tokens. Must be secret and stable across restarts. */
  sessionSecret: string;
  sessionTtlSeconds?: number;
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid_token"
      | "not_verified"
      | "banned"
      | "pending"
      | "denied"
      | "expired"
      | "bad_signature",
  ) {
    super(message);
    this.name = "AuthError";
  }
}

/**
 * Ties Migood identities to MiBlox accounts and mints our own session tokens.
 *
 * Linking rule: Migood's numeric user id is the strong key, but only
 * /api/sendinfo exposes it. Logins that arrive without one fall back to the
 * Migood username, and the id is backfilled the first time we do see it.
 */
export class AuthService {
  private readonly client: MigoodClient;
  private readonly store: AccountStore;
  private readonly sessionSecret: string;
  private readonly sessionTtl: number;

  constructor(opts: AuthServiceOptions) {
    this.client = opts.client;
    this.store = opts.store;
    this.sessionSecret = opts.sessionSecret;
    this.sessionTtl = opts.sessionTtlSeconds ?? 60 * 60 * 12;
    if (!this.sessionSecret || this.sessionSecret.length < 16) {
      throw new Error("sessionSecret must be at least 16 characters");
    }
  }

  // -- flow 1: in-frame SDK token (preferred; yields a stable Migood id) -----

  /**
   * Verifies a token from the in-page SDK via /api/sendinfo. This is the flow
   * to use when MiBlox is played on Migood Games itself.
   */
  async loginWithGameToken(gameToken: string): Promise<LoginResult> {
    const info = await this.client.sendInfo(gameToken);
    if (!info.verified) throw new AuthError("Migood did not verify this token", "not_verified");
    return this.upsert({
      userId: info.id,
      username: info.username,
      displayName: info.displayName,
      avatar: info.avatar,
      scopes: info.scopes ?? [],
      linkedAt: Date.now(),
    });
  }

  // -- flow 2: authorization code (browser redirect) -------------------------

  /** Builds the consent URL. Keep `state` and check it on the way back. */
  authorizeUrl(redirectUri: string, state: string, scope = ["identify"]): string {
    return this.client.authorizeUrl({ redirectUri, scope, state });
  }

  async loginWithAuthCode(code: string, redirectUri: string): Promise<LoginResult> {
    const token = await this.client.exchangeCode(code, redirectUri);
    return this.loginWithAccessToken(token.access_token, token.scope);
  }

  private async loginWithAccessToken(accessToken: string, scope: string): Promise<LoginResult> {
    const info = await this.client.userInfo(accessToken);
    return this.upsert({
      // /api/oauth/userinfo carries no numeric id, so this link starts weak.
      username: info.username,
      displayName: info.displayName,
      avatar: info.avatar,
      scopes: scope ? scope.split(/\s+/).filter(Boolean) : [],
      linkedAt: Date.now(),
    });
  }

  // -- flow 3: device code (no browser redirect: desktop, VR, console) -------

  /** Shows the player a short code to type into Migood's "Enter Code" screen. */
  startDeviceLogin(scope = ["identify"], quick = false): Promise<DeviceInitResult> {
    return this.client.deviceInit(scope, quick);
  }

  /**
   * Polls one device login. Throws AuthError("pending") while the player has
   * not answered yet, so callers can simply retry on that code.
   */
  async completeDeviceLogin(deviceCode: string): Promise<LoginResult> {
    const result = await this.client.devicePoll(deviceCode);
    switch (result.status) {
      case "pending":
        throw new AuthError("The player has not approved this code yet", "pending");
      case "denied":
        throw new AuthError("The player denied the request", "denied");
      case "expired":
        throw new AuthError("The code expired before it was used", "expired");
      case "approved": {
        const token = await this.client.exchangeCode(result.code, REDIRECT_DEVICE);
        return this.loginWithAccessToken(token.access_token, token.scope);
      }
    }
  }

  // -- flow 4: built-in verification webhook --------------------------------

  /**
   * Handles a signed `oauth_verified` POST. The signature is checked before the
   * body is trusted for anything, which is what stops a forged verification.
   */
  async handleVerificationWebhook(
    rawBody: string,
    signatureHex: string,
  ): Promise<{ state: string; login: LoginResult }> {
    if (!this.client.verifyWebhookSignature(rawBody, signatureHex)) {
      throw new AuthError("Webhook signature did not match", "bad_signature");
    }
    const payload = JSON.parse(rawBody) as {
      event: string;
      code: string;
      state: string;
      clientId: string;
    };
    if (payload.event !== "oauth_verified") {
      throw new AuthError(`Unexpected webhook event "${payload.event}"`, "invalid_token");
    }
    if (payload.clientId !== this.client.clientId) {
      throw new AuthError("Webhook was for a different app", "invalid_token");
    }
    const token = await this.client.exchangeCode(payload.code, REDIRECT_BUILTIN);
    const login = await this.loginWithAccessToken(token.access_token, token.scope);
    return { state: payload.state, login };
  }

  // -- account linking ------------------------------------------------------

  private async upsert(link: MigoodLink): Promise<LoginResult> {
    const existing = await this.store.findByLink({
      userId: link.userId,
      username: link.username,
    });

    if (existing) {
      if (existing.banned && (!existing.banned.until || existing.banned.until > Date.now())) {
        throw new AuthError(`This account is suspended: ${existing.banned.reason}`, "banned");
      }
      // Refresh the link so a Migood rename or avatar change follows through,
      // and backfill the numeric id the first time we learn it.
      existing.link = {
        ...existing.link,
        ...link,
        userId: link.userId ?? existing.link.userId,
        linkedAt: existing.link.linkedAt,
      };
      existing.lastSeenAt = Date.now();
      await this.store.put(existing);
      return { account: existing, session: this.issueSession(existing), created: false };
    }

    const now = Date.now();
    const username = await suggestUsername(link.username, this.store);
    const account: Account = {
      id: newAccountId(),
      username,
      usernameLower: username.toLowerCase(),
      link,
      createdAt: now,
      lastSeenAt: now,
      avatar: defaultAvatar(),
    };
    await this.store.put(account);
    return { account, session: this.issueSession(account), created: true };
  }

  /** Replaces a player's avatar. */
  async setAvatar(accountId: string, avatar: unknown): Promise<Account> {
    const account = await this.store.get(accountId);
    if (!account) throw new AuthError("No such account", "invalid_token");
    account.avatar = avatar as Account["avatar"];
    await this.store.put(account);
    return account;
  }

  /** Looks an account up by its MiBlox username, for avatar lookups. */
  findByUsername(username: string): Promise<Account | null> {
    return this.store.findByUsername(username);
  }

  /** Every account, for the player directory. */
  allAccounts(): Promise<Account[]> {
    return this.store.all();
  }

  /** Renames a MiBlox account. Allowed at any time; the link is untouched. */
  async setUsername(accountId: string, username: string): Promise<Account> {
    validateUsername(username);
    const account = await this.store.get(accountId);
    if (!account) throw new AuthError("No such account", "invalid_token");
    const taken = await this.store.findByUsername(username);
    if (taken && taken.id !== accountId) {
      throw new UsernameError(`"${username}" is already taken`);
    }
    account.username = username;
    account.usernameLower = username.toLowerCase();
    await this.store.put(account);
    return account;
  }

  // -- our own session tokens ----------------------------------------------

  issueSession(account: Account): string {
    const now = Math.floor(Date.now() / 1000);
    const payload: SessionPayload = {
      sub: account.id,
      name: account.username,
      iat: now,
      exp: now + this.sessionTtl,
    };
    const body = b64url(JSON.stringify(payload));
    return `${body}.${this.sign(body)}`;
  }

  /** Verifies signature and expiry, then re-reads the account from the store. */
  async verifySession(token: string): Promise<Account> {
    const dot = token.lastIndexOf(".");
    if (dot <= 0) throw new AuthError("Malformed session token", "invalid_token");
    const body = token.slice(0, dot);
    const signature = token.slice(dot + 1);
    const expected = this.sign(body);
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new AuthError("Session signature did not match", "invalid_token");
    }
    let payload: SessionPayload;
    try {
      payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload;
    } catch {
      throw new AuthError("Malformed session payload", "invalid_token");
    }
    if (payload.exp * 1000 < Date.now()) {
      throw new AuthError("Session expired", "expired");
    }
    const account = await this.store.get(payload.sub);
    if (!account) throw new AuthError("Account no longer exists", "invalid_token");
    if (account.banned && (!account.banned.until || account.banned.until > Date.now())) {
      throw new AuthError(`This account is suspended: ${account.banned.reason}`, "banned");
    }
    return account;
  }

  private sign(body: string): string {
    return createHmac("sha256", this.sessionSecret).update(body).digest("base64url");
  }
}

function b64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

/** Cryptographically random `state` for the redirect flow. */
export function newState(): string {
  return randomBytes(24).toString("base64url");
}
