import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Client for the Migood Games OAuth API.
 *
 * Every call in here is server-to-server and needs the client secret, so this
 * module must never be bundled into the client. The browser only ever handles
 * short-lived game tokens and authorization codes.
 */

export const MIGOOD_BASE = "https://www.welltypers.it.com";

export interface MigoodConfig {
  clientId: string;
  /** Server-side only. Never ship this to a client. */
  clientSecret: string;
  /** Signing secret for built-in verification webhooks, when enabled. */
  webhookSecret?: string;
  baseUrl?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  persistent?: boolean;
}

/** Shape returned by /api/oauth/userinfo. Note: no stable numeric id. */
export interface UserInfo {
  username: string;
  displayName: string;
  avatar: string;
  avatarBase64?: string;
}

/** Shape returned by /api/sendinfo. This one does carry a stable id. */
export interface SendInfoResult {
  verified: boolean;
  id: number;
  username: string;
  displayName: string;
  avatar: string;
  scopes: string[];
  gameSlug?: string;
  issuedAt: number;
  expiresAt: number;
}

export interface DeviceInitResult {
  /** Short code to read out to the player. */
  user_code: string;
  /** Secret handle for polling. Never show this to the player. */
  device_code: string;
  expires_in: number;
}

export type DevicePollResult =
  | { status: "pending" }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "approved"; code: string };

export class MigoodError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "MigoodError";
  }
}

/** Literal redirect_uri values Migood defines for the no-website flows. */
export const REDIRECT_BUILTIN = "builtinoauth";
export const REDIRECT_DEVICE = "devicecode";

export class MigoodClient {
  private readonly baseUrl: string;
  private readonly doFetch: typeof fetch;

  constructor(private readonly config: MigoodConfig) {
    this.baseUrl = (config.baseUrl ?? MIGOOD_BASE).replace(/\/$/, "");
    this.doFetch = config.fetchImpl ?? globalThis.fetch;
    if (!this.doFetch) throw new Error("No fetch implementation available");
  }

  get clientId(): string {
    return this.config.clientId;
  }

  /**
   * Builds the consent-screen URL. `state` is required rather than optional:
   * it is the only CSRF protection this flow has.
   */
  authorizeUrl(opts: { redirectUri: string; scope: string[]; state: string }): string {
    const url = new URL(`${this.baseUrl}/oauth/authorize`);
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", opts.redirectUri);
    url.searchParams.set("scope", opts.scope.join(" "));
    url.searchParams.set("state", opts.state);
    return url.toString();
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const res = await this.doFetch(`${this.baseUrl}${path}`, init);
    const text = await res.text();
    if (!res.ok) {
      throw new MigoodError(
        `Migood ${path} failed with ${res.status}${describeStatus(res.status)}`,
        res.status,
        text,
      );
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new MigoodError(`Migood ${path} returned non-JSON`, res.status, text);
    }
  }

  private postJson<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /** Exchanges an authorization code for tokens. Codes expire in 2 minutes. */
  exchangeCode(code: string, redirectUri: string): Promise<TokenResponse> {
    return this.postJson<TokenResponse>("/oauth/token", {
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      code,
      redirect_uri: redirectUri,
    });
  }

  /** Refresh tokens are single-use: always persist the one you get back. */
  refresh(refreshToken: string): Promise<TokenResponse> {
    return this.postJson<TokenResponse>("/oauth/token", {
      grant_type: "refresh_token",
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      refresh_token: refreshToken,
    });
  }

  userInfo(accessToken: string): Promise<UserInfo> {
    return this.request<UserInfo>("/api/oauth/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  }

  /**
   * Verifies an in-frame SDK game token. This is the only endpoint that hands
   * back a stable numeric user id, so it is the preferred way to link accounts.
   */
  sendInfo(gameToken: string): Promise<SendInfoResult> {
    return this.postJson<SendInfoResult>("/api/sendinfo", {
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      token: gameToken,
    });
  }

  /** Starts a device-code login, for clients with no browser redirect. */
  deviceInit(scope: string[], quick = false): Promise<DeviceInitResult> {
    return this.postJson<DeviceInitResult>("/api/oauth/device/init", {
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      scope: scope.join(" "),
      quick,
    });
  }

  devicePoll(deviceCode: string): Promise<DevicePollResult> {
    const url = new URL(`${this.baseUrl}/api/oauth/device/poll`);
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("client_secret", this.config.clientSecret);
    url.searchParams.set("device_code", deviceCode);
    return this.request<DevicePollResult>(
      `${url.pathname}${url.search}`,
      { method: "GET" },
    );
  }

  /**
   * Verifies a built-in-verification webhook body against its HMAC signature.
   * Compare in constant time; a plain === leaks timing information.
   */
  verifyWebhookSignature(rawBody: string, signatureHex: string): boolean {
    const secret = this.config.webhookSecret;
    if (!secret) throw new Error("No webhookSecret configured");
    const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest();
    let received: Buffer;
    try {
      received = Buffer.from(signatureHex, "hex");
    } catch {
      return false;
    }
    if (received.length !== expected.length) return false;
    return timingSafeEqual(expected, received);
  }
}

function describeStatus(status: number): string {
  switch (status) {
    case 400: return " (a required field is missing)";
    case 401: return " (unknown client, wrong secret, or an expired token)";
    case 403: return " (app banned, scope restricted, or token minted for another app)";
    case 404: return " (the player no longer exists)";
    default: return "";
  }
}
