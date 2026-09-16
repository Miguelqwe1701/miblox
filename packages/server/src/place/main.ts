#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import type { SerializedPlace } from "@miblox/core";
import { PlaceHost } from "./host.js";

/**
 * Game-server process entry.
 *
 * The portal spawns one of these per running place and talks to it over the
 * Node IPC channel. Keeping each place in its own process means a script that
 * hangs, leaks or crashes takes down that game and nothing else.
 */

export interface PlaceProcessMessage {
  type: "ready" | "status" | "log" | "error";
  port?: number;
  players?: number;
  message?: string;
}

async function main(): Promise<void> {
  const placePath = process.env.MIBLOX_PLACE_FILE;
  const placeId = process.env.MIBLOX_PLACE_ID ?? "place";
  const port = Number(process.env.MIBLOX_PLACE_PORT ?? 0);
  const ticketSecret = process.env.MIBLOX_TICKET_SECRET;
  const serverAuthoritative = process.env.MIBLOX_SERVER_AUTH === "1";
  const tickRate = Number(process.env.MIBLOX_TICK_RATE ?? 30);
  const maxPlayers = Number(process.env.MIBLOX_MAX_PLAYERS ?? 32);

  if (!placePath) {
    console.error("MIBLOX_PLACE_FILE is required");
    process.exit(1);
  }

  const place = JSON.parse(await readFile(placePath, "utf8")) as SerializedPlace;
  const send = (message: PlaceProcessMessage): void => {
    process.send?.(message);
  };

  const host = new PlaceHost({
    place,
    placeId,
    port,
    ticketSecret,
    serverAuthoritative,
    tickRate,
    maxPlayers,
    log: (message) => {
      console.log(`[${placeId}] ${message}`);
      send({ type: "log", message });
    },
  });

  const actualPort = await host.listen();
  send({ type: "ready", port: actualPort });

  // Lets the portal show live player counts without polling over HTTP.
  const statusTimer = setInterval(() => {
    send({ type: "status", players: host.place.playerCount });
  }, 5000);

  const shutdown = async (signal: string): Promise<void> => {
    clearInterval(statusTimer);
    console.log(`[${placeId}] shutting down (${signal})`);
    await host.close();
    process.exit(0);
  };

  process.on("message", (message: { type?: string }) => {
    if (message?.type === "shutdown") void shutdown("portal");
  });
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // A crash in one game must be reported, not swallowed.
  process.on("uncaughtException", (err) => {
    console.error(`[${placeId}] uncaught:`, err);
    send({ type: "error", message: String(err?.stack ?? err) });
  });
  process.on("unhandledRejection", (err) => {
    console.error(`[${placeId}] unhandled rejection:`, err);
    send({ type: "error", message: String(err) });
  });
}

main().catch((err) => {
  console.error("[place] failed to start:", err);
  process.exit(1);
});
