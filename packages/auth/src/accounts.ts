import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * A MiBlox account. The account is ours: it has its own id and its own
 * username that the player may change whenever they like. Migood is only the
 * identity it is *linked* to, never the source of the display name.
 */
export interface Account {
  /** Our own stable id. Never changes, never reused, safe to key everything on. */
  id: string;
  /** MiBlox username, chosen by the player and changeable at any time. */
  username: string;
  /** Lowercased username, kept for case-insensitive uniqueness checks. */
  usernameLower: string;
  link: MigoodLink;
  createdAt: number;
  lastSeenAt: number;
  /** Set when a moderator suspends the account; blocks login while present. */
  banned?: { reason: string; until?: number };
}

export interface MigoodLink {
  /**
   * Migood's numeric user id. Only /api/sendinfo exposes this, so it is absent
   * for accounts that have only ever logged in through the OAuth code flow.
   */
  userId?: number;
  /** Migood username at last login. Unique on their side, but can be renamed. */
  username: string;
  displayName: string;
  avatar?: string;
  scopes: string[];
  linkedAt: number;
}

export interface AccountStore {
  get(id: string): Promise<Account | null>;
  /** Looks up by Migood numeric id first, then by Migood username. */
  findByLink(link: { userId?: number; username: string }): Promise<Account | null>;
  findByUsername(username: string): Promise<Account | null>;
  put(account: Account): Promise<void>;
  all(): Promise<Account[]>;
}

export const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,20}$/;

/** Names nobody may take, to avoid impersonating the game or its staff. */
const RESERVED = new Set([
  "admin", "administrator", "moderator", "mod", "miblox", "migood", "system",
  "server", "console", "staff", "support", "root", "owner", "null", "undefined",
]);

export class UsernameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsernameError";
  }
}

export function validateUsername(name: string): void {
  if (!USERNAME_PATTERN.test(name)) {
    throw new UsernameError(
      "Usernames must be 3-20 characters, using only letters, numbers and underscores",
    );
  }
  if (RESERVED.has(name.toLowerCase())) {
    throw new UsernameError(`"${name}" is reserved`);
  }
}

/**
 * Derives a starting MiBlox username from the Migood one. The player can change
 * it immediately afterwards; this only needs to be valid and unique.
 */
export async function suggestUsername(base: string, store: AccountStore): Promise<string> {
  let cleaned = base.replace(/[^A-Za-z0-9_]/g, "").slice(0, 20);
  if (cleaned.length < 3) cleaned = `player${cleaned}`;
  if (RESERVED.has(cleaned.toLowerCase())) cleaned = `${cleaned}_`;
  if (!(await store.findByUsername(cleaned))) return cleaned;
  for (let i = 2; i < 10000; i++) {
    const suffix = String(i);
    const candidate = `${cleaned.slice(0, 20 - suffix.length)}${suffix}`;
    if (!(await store.findByUsername(candidate))) return candidate;
  }
  return `player_${randomUUID().slice(0, 8)}`;
}

export class MemoryAccountStore implements AccountStore {
  protected accounts = new Map<string, Account>();

  async get(id: string): Promise<Account | null> {
    return this.accounts.get(id) ?? null;
  }

  async findByLink(link: { userId?: number; username: string }): Promise<Account | null> {
    // The numeric id is stable across Migood renames, so it wins when present.
    if (link.userId !== undefined) {
      for (const account of this.accounts.values()) {
        if (account.link.userId === link.userId) return account;
      }
    }
    const lower = link.username.toLowerCase();
    for (const account of this.accounts.values()) {
      // Only match on username for links that have no id recorded yet;
      // otherwise a renamed Migood user could collide with someone else.
      if (account.link.userId === undefined && account.link.username.toLowerCase() === lower) {
        return account;
      }
    }
    return null;
  }

  async findByUsername(username: string): Promise<Account | null> {
    const lower = username.toLowerCase();
    for (const account of this.accounts.values()) {
      if (account.usernameLower === lower) return account;
    }
    return null;
  }

  async put(account: Account): Promise<void> {
    this.accounts.set(account.id, account);
  }

  async all(): Promise<Account[]> {
    return [...this.accounts.values()];
  }
}

/**
 * File-backed store. Fine for a single game server; swap in a real database
 * behind the same AccountStore interface when there is more than one.
 */
export class JsonAccountStore extends MemoryAccountStore {
  private loaded = false;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {
    super();
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await readFile(this.path, "utf8");
      for (const account of JSON.parse(raw) as Account[]) {
        this.accounts.set(account.id, account);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  override async get(id: string): Promise<Account | null> {
    await this.load();
    return super.get(id);
  }

  override async findByLink(link: { userId?: number; username: string }) {
    await this.load();
    return super.findByLink(link);
  }

  override async findByUsername(username: string) {
    await this.load();
    return super.findByUsername(username);
  }

  override async all(): Promise<Account[]> {
    await this.load();
    return super.all();
  }

  override async put(account: Account): Promise<void> {
    await this.load();
    await super.put(account);
    await this.flush();
  }

  /** Serialized writes through a temp file, so a crash cannot truncate it. */
  private flush(): Promise<void> {
    this.writing = this.writing.then(async () => {
      const data = JSON.stringify([...this.accounts.values()], null, 2);
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.${process.pid}.tmp`;
      await writeFile(tmp, data, "utf8");
      await rename(tmp, this.path);
    });
    return this.writing;
  }
}

export function newAccountId(): string {
  return randomUUID();
}
