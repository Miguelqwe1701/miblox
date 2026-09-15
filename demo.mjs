import { chromium } from "playwright";
import { mkdir, rm } from "node:fs/promises";

const OUT = "/home/user/miblox/demo";
await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

// The sandbox ships Chromium at a fixed path; use it rather than downloading.
const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: [
    "--use-gl=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
    "--no-sandbox",
  ],
});

const context = await browser.newContext({
  viewport: { width: 1440, height: 810 },
  deviceScaleFactor: 1,
  recordVideo: { dir: OUT, size: { width: 1440, height: 810 } },
});
const page = await context.newPage();

const problems = [];
page.on("console", (m) => {
  if (m.type() === "error") problems.push(m.text());
});
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));

const shot = async (name) => {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log("captured", name);
};

await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
await page.waitForSelector(".card", { timeout: 15000 });
await page.waitForTimeout(700);
await shot("01-main-menu");

// Join. The portal launches a game-server process for this world.
await page.click(".card .play");
await page.waitForTimeout(700);
await shot("02-loading");

await page.waitForFunction(() => !document.querySelector(".game")?.hidden, { timeout: 40000 });
await page.waitForTimeout(6000);
await shot("03-in-game");

console.log("STATS:", await page.evaluate(() => {
  const c = window.miblox;
  return {
    place: c.connection.placeName,
    chunks: c.terrainView.stats.chunks,
    tris: c.terrainView.stats.triangles,
    backend: c.terrainView.stats.backend,
    parts: c.worldView.partCount,
    ownsCharacter: !c.connection.serverAuthoritative,
  };
}));

// Look around so the video shows the world.
await page.mouse.move(720, 405);
for (let i = 0; i < 70; i++) {
  await page.mouse.move(720 + i * 7, 405 + Math.sin(i / 9) * 35);
  await page.waitForTimeout(16);
}
await shot("04-looking-around");

// Walk.
await page.keyboard.down("KeyW");
await page.waitForTimeout(3000);
await page.keyboard.up("KeyW");
await page.waitForTimeout(700);
await shot("05-walking");

// Jump.
await page.keyboard.down("Space");
await page.waitForTimeout(140);
await page.keyboard.up("Space");
await page.waitForTimeout(350);
await shot("06-jumping");
await page.waitForTimeout(1200);

// Hotbar: pick rock, then build.
await page.keyboard.press("3");
await page.waitForTimeout(400);
await shot("07-hotbar-rock");
for (let i = 0; i < 6; i++) {
  await page.mouse.click(720, 405);
  await page.waitForTimeout(280);
}
await page.waitForTimeout(1200);
await shot("08-built-terrain");

// Dig with right click.
for (let i = 0; i < 4; i++) {
  await page.mouse.click(720, 430, { button: "right" });
  await page.waitForTimeout(280);
}
await page.waitForTimeout(1200);
await shot("09-dug-terrain");

// Chat.
await page.keyboard.press("Enter");
await page.waitForTimeout(250);
await page.keyboard.type("smooth terrain works");
await page.keyboard.press("Enter");
await page.waitForTimeout(900);
await shot("10-chat");

// Player list.
await page.keyboard.down("Tab");
await page.waitForTimeout(700);
await shot("11-player-list");
await page.keyboard.up("Tab");

// Developer stats.
await page.keyboard.press("F3");
await page.waitForTimeout(700);
await shot("12-stats");
await page.keyboard.press("F3");

// Pause menu and settings.
await page.keyboard.press("Escape");
await page.waitForTimeout(600);
await shot("13-pause-menu");
await page.click(".open-settings");
await page.waitForTimeout(600);
await shot("14-settings");

// Switch to blocky terrain to show both styles.
await page.selectOption(".set-terrain", "blocky");
await page.waitForTimeout(2500);
await page.click(".close-settings");
await page.keyboard.press("Escape");
await page.waitForTimeout(2000);
await shot("15-blocky-terrain");

// Back to smooth.
await page.keyboard.press("Escape");
await page.click(".open-settings");
await page.selectOption(".set-terrain", "smooth");
await page.waitForTimeout(2500);
await page.click(".close-settings");
await page.keyboard.press("Escape");
await page.waitForTimeout(2000);
await shot("16-smooth-terrain");

console.log("FINAL:", await page.evaluate(() => {
  const c = window.miblox;
  const r = c.simulation.root;
  return {
    position: [r.CFrame.position.x, r.CFrame.position.y, r.CFrame.position.z].map(Math.round),
    chunks: c.terrainView.stats.chunks,
    tris: c.terrainView.stats.triangles,
  };
}));

if (problems.length) {
  console.log("\nPAGE PROBLEMS:");
  for (const p of problems.slice(0, 10)) console.log(" -", p);
} else {
  console.log("\nno page errors");
}

await context.close();
await browser.close();
console.log("done");
