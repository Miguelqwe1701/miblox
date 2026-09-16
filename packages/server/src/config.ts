import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { AuthService, JsonAccountStore, MigoodClient } from "@miblox/auth";
import type { GameDefinition } from "./portal/manager.js";

export interface PortalConfig {
  port: number;
  publicHost: string;
  publicUrl?: string;
  clientDir?: string;
  ticketSecret: string;
  placesDir: string;
  accountsFile: string;
  basePort: number;
}

/** Reads configuration from the environment, with usable defaults. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): PortalConfig {
  return {
    port: Number(env.MIBLOX_PORT ?? 3000),
    publicHost: env.MIBLOX_PUBLIC_HOST ?? "localhost",
    publicUrl: env.MIBLOX_PUBLIC_URL,
    clientDir: env.MIBLOX_CLIENT_DIR ?? resolve(process.cwd(), "packages/client/dist"),
    // A random secret still works for a single run; it only needs to be stable
    // if portal and game servers are restarted independently.
    ticketSecret: env.MIBLOX_TICKET_SECRET ?? randomBytes(32).toString("base64url"),
    placesDir: env.MIBLOX_PLACES_DIR ?? resolve(process.cwd(), "places"),
    accountsFile: env.MIBLOX_ACCOUNTS_FILE ?? resolve(process.cwd(), "data/accounts.json"),
    basePort: Number(env.MIBLOX_BASE_PORT ?? 7100),
  };
}

/**
 * Builds the auth service, or returns undefined when Migood is not configured.
 *
 * Running without it is a supported mode, not an error: local development and
 * anywhere `Migood.available` is false both fall back to guest play.
 */
export function buildAuthService(
  config: PortalConfig,
  env: NodeJS.ProcessEnv = process.env,
): AuthService | undefined {
  const clientId = env.MIBLOX_MIGOOD_CLIENT_ID;
  const clientSecret = env.MIBLOX_MIGOOD_CLIENT_SECRET;
  if (!clientId || !clientSecret) return undefined;

  const sessionSecret = env.MIBLOX_SESSION_SECRET;
  if (!sessionSecret || sessionSecret.length < 16) {
    throw new Error(
      "MIBLOX_SESSION_SECRET must be set to at least 16 characters when Migood sign-in is enabled. " +
        "It signs player sessions, so it must stay the same across restarts.",
    );
  }

  const client = new MigoodClient({
    clientId,
    clientSecret,
    webhookSecret: env.MIBLOX_MIGOOD_WEBHOOK_SECRET,
  });
  return new AuthService({
    client,
    store: new JsonAccountStore(config.accountsFile),
    sessionSecret,
  });
}

/** Loads every place file in `placesDir` as a playable game. */
export async function discoverGames(placesDir: string): Promise<GameDefinition[]> {
  let entries: string[];
  try {
    entries = await readdir(placesDir);
  } catch {
    return [];
  }

  const games: GameDefinition[] = [];
  for (const entry of entries) {
    if (extname(entry) !== ".json") continue;
    const placeFile = resolve(placesDir, entry);
    try {
      const place = JSON.parse(await readFile(placeFile, "utf8")) as {
        name?: string;
        description?: string;
        maxPlayers?: number;
        serverAuthoritative?: boolean;
        tickRate?: number;
      };
      const id = basename(entry, ".json");
      games.push({
        id,
        name: place.name ?? id,
        description: place.description ?? "",
        placeFile,
        maxPlayers: place.maxPlayers,
        serverAuthoritative: place.serverAuthoritative,
        tickRate: place.tickRate,
      });
    } catch (err) {
      console.warn(`[portal] skipping ${entry}: ${String(err)}`);
    }
  }
  return games;
}
