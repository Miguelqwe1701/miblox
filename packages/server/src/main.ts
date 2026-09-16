#!/usr/bin/env node
import { buildAuthService, discoverGames, loadConfig } from "./config.js";
import { ServerManager } from "./portal/manager.js";
import { PortalServer } from "./portal/http.js";

/**
 * Portal entry point: serves the website, handles sign-in, and launches a
 * game-server process for each place players want to join.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const auth = buildAuthService(config);

  const manager = new ServerManager({
    ticketSecret: config.ticketSecret,
    basePort: config.basePort,
  });

  const games = await discoverGames(config.placesDir);
  for (const game of games) manager.registerGame(game);
  console.log(
    games.length
      ? `[portal] found ${games.length} place(s) in ${config.placesDir}`
      : `[portal] no places found in ${config.placesDir}; run "npm run place:build" to create one`,
  );

  const portal = new PortalServer({
    port: config.port,
    manager,
    auth,
    ticketSecret: config.ticketSecret,
    clientDir: config.clientDir,
    publicHost: config.publicHost,
    publicUrl: config.publicUrl,
  });
  await portal.listen();

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[portal] shutting down (${signal})`);
    await portal.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[portal] failed to start:", err);
  process.exit(1);
});
