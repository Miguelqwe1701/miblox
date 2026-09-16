/**
 * Records a walkthrough of MiBlox by driving a real browser against a running
 * portal. Nothing here is mocked: the portal forks a game-server process, the
 * browser joins it over WebSocket, and these are screenshots of that session.
 *
 *   npm run build && npm run place:build && npm run portal restart
 *   node demo.mjs
 */
import { chromium } from "playwright";
import { mkdir, rename, readdir } from "node:fs/promises";

const OUT = "/home/user/miblox/demo";
const PORTAL = "http://localhost:3000";
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
// The character adder prompts for a username.
await page.addInitScript(() => {
  window.prompt = (msg, def) => (msg.includes("Whose avatar") ? "Template" : def ?? "");
});

let shotNumber = 0;
const shot = async (name) => {
  shotNumber += 1;
  const file = `${String(shotNumber).padStart(2, "0")}-${name}`;
  await page.screenshot({ path: `${OUT}/${file}.png` });
  console.log("  captured", file);
};
const step = (text) => console.log(`\n${text}`);

// -- the website ------------------------------------------------------------

step("Main menu");
await page.goto(PORTAL, { waitUntil: "networkidle" });
await page.waitForSelector(".enter-lobby", { timeout: 20000 });
await page.waitForTimeout(900);
await shot("main-menu");

// -- the lobby --------------------------------------------------------------

step("Lobby: a world you join, with the catalogue on panels inside it");
await page.click(".enter-lobby");
await page.waitForFunction(() => !document.querySelector(".game")?.hidden, undefined, {
  timeout: 45000,
});
await page.waitForTimeout(7000);
await shot("lobby");

// Look around until a panel is under the crosshair.
for (let i = 0; i < 30 && !(await page.evaluate(() => window.miblox.aimedAt)); i++) {
  await page.mouse.move(720 + i * 8, 405);
  await page.waitForTimeout(60);
}
await page.waitForTimeout(1200);
const aimed = await page.evaluate(() => window.miblox.aimedAt);
console.log("  pointing at:", aimed);
await shot("lobby-pointing");

step("Selecting a world from inside the lobby");
await page.mouse.click(720, 405);
await page.waitForFunction(
  () => window.miblox?.connection?.placeName === "Baseplate",
  undefined,
  { timeout: 60000 },
);
await page.waitForTimeout(7000);
await shot("joined-world");

console.log("  world:", await page.evaluate(() => {
  const c = window.miblox;
  return {
    place: c.connection.placeName,
    chunks: c.terrainView.stats.chunks,
    triangles: c.terrainView.stats.triangles,
    mesher: c.terrainView.stats.backend,
    parts: c.worldView.partCount,
    ownsCharacter: !c.connection.serverAuthoritative,
  };
}));

// -- playing ----------------------------------------------------------------

step("Playing: look, walk, jump");
await page.mouse.move(720, 405);
for (let i = 0; i < 60; i++) {
  await page.mouse.move(720 + i * 7, 405 + Math.sin(i / 9) * 30);
  await page.waitForTimeout(16);
}
await shot("looking-around");

await page.keyboard.down("KeyW");
await page.waitForTimeout(2600);
await page.keyboard.up("KeyW");
await page.waitForTimeout(600);
await shot("walking");

await page.keyboard.down("Space");
await page.waitForTimeout(140);
await page.keyboard.up("Space");
await page.waitForTimeout(320);
await shot("jumping");
await page.waitForTimeout(1400);

step("Building and digging terrain");
await page.keyboard.press("3");
await page.waitForTimeout(500);
for (let i = 0; i < 8; i++) {
  await page.mouse.click(720, 430);
  await page.waitForTimeout(260);
}
await page.waitForTimeout(1400);
await shot("built-terrain");

for (let i = 0; i < 5; i++) {
  await page.mouse.click(700, 440, { button: "right" });
  await page.waitForTimeout(260);
}
await page.waitForTimeout(1400);
await shot("dug-terrain");

step("Chat, player list, developer stats");
await page.keyboard.press("Enter");
await page.waitForTimeout(220);
await page.keyboard.type("built a wall");
await page.keyboard.press("Enter");
await page.waitForTimeout(900);
await shot("chat");

await page.keyboard.down("Tab");
await page.waitForTimeout(700);
await shot("player-list");
await page.keyboard.up("Tab");

await page.keyboard.press("F3");
await page.waitForTimeout(700);
await shot("stats");
await page.keyboard.press("F3");

step("Pause menu and settings");
await page.keyboard.press("Escape");
await page.waitForTimeout(600);
await shot("pause-menu");
await page.click(".open-settings");
await page.waitForTimeout(600);
await shot("settings");

step("Switching terrain style: smooth to blocky and back");
await page.selectOption(".set-terrain", "blocky");
await page.waitForTimeout(2600);
await page.click(".close-settings");
await page.keyboard.press("Escape");
await page.waitForTimeout(1800);
await shot("blocky-terrain");

await page.keyboard.press("Escape");
await page.click(".open-settings");
await page.selectOption(".set-terrain", "smooth");
await page.waitForTimeout(2600);
await page.click(".close-settings");
await page.keyboard.press("Escape");
await page.waitForTimeout(1800);
await shot("smooth-terrain");

// -- the avatar editor ------------------------------------------------------

step("Avatar editor");
await page.goto(`${PORTAL}/avatar`, { waitUntil: "networkidle" });
await page.waitForSelector(".body-panel", { timeout: 20000 });
await page.waitForTimeout(3500);
await shot("avatar-body");

await page.click('.tab:has-text("Shirts")');
await page.waitForTimeout(700);
await shot("avatar-shirts");
let options = await page.$$(".asset");
await options[5].click();
await page.waitForTimeout(1100);

await page.click('.tab:has-text("Pants")');
await page.waitForTimeout(400);
options = await page.$$(".asset");
await options[2].click();
await page.waitForTimeout(800);

await page.click('.tab:has-text("Hats")');
await page.waitForTimeout(400);
options = await page.$$(".asset");
await options[3].click();
await page.waitForTimeout(1600);
await shot("avatar-dressed");

await page.click(".randomise");
await page.waitForTimeout(2200);
await shot("avatar-randomised");

// -- studio -----------------------------------------------------------------

step("Studio");
await page.goto(`${PORTAL}/studio/baseplate`, { waitUntil: "networkidle" });
await page.waitForFunction(
  () => document.querySelector(".status")?.textContent?.includes("Editing"),
  undefined,
  { timeout: 45000 },
);
await page.waitForTimeout(5000);
await shot("studio");

await page.click(".explorer .node .twisty");
await page.waitForTimeout(600);
for (const node of await page.$$(".explorer .node")) {
  if ((await node.textContent())?.includes("Baseplate")) {
    await node.click();
    break;
  }
}
await page.waitForTimeout(900);
await shot("studio-properties");

step("Studio: terrain sculpting");
await page.click('.tool[data-tool="terrain-add"]');
await page.waitForTimeout(400);
for (let i = 0; i < 6; i++) {
  await page.mouse.move(640 + i * 40, 400);
  await page.mouse.down();
  await page.mouse.move(670 + i * 40, 420);
  await page.mouse.up();
  await page.waitForTimeout(450);
}
await page.waitForTimeout(1600);
await shot("studio-sculpting");
await page.click('.tool[data-tool="select"]');

step("Studio: the Character Adder plugin");
for (const button of await page.$$(".plugin-button")) {
  if ((await button.textContent()) === "Add Template") {
    await button.click();
    break;
  }
}
await page.waitForTimeout(2600);
await page.keyboard.press("f");
await page.waitForTimeout(1600);
await shot("studio-character-adder");

console.log("  added:", await page.evaluate(() => {
  const model = window.studio.game.Workspace.FindFirstChild("Template");
  if (!model) return null;
  return {
    accessories: model.GetChildren().filter((c) => c.className === "Accessory").map((c) => c.Name),
    shirt: model.FindFirstChildOfClass("Shirt")?.AssetId,
    pants: model.FindFirstChildOfClass("Pants")?.AssetId,
  };
}));

await page.click(".manage-plugins");
await page.waitForTimeout(800);
await shot("studio-plugins");
await page.click(".close-plugins");

step("Studio: script editor");
for (const node of await page.$$(".explorer .node")) {
  if ((await node.textContent())?.includes("ServerScrip")) {
    await node.$$eval(".twisty", (els) => els[0]?.click());
    break;
  }
}
await page.waitForTimeout(600);
for (const node of await page.$$(".explorer .node")) {
  const text = await node.textContent();
  if (text?.includes("Main") && text?.includes("Script")) {
    await node.click();
    break;
  }
}
await page.waitForTimeout(900);
await shot("studio-script-editor");

step("Studio: a test server, with the Server/Client switcher");
await page.click(".test-play");
await page.waitForTimeout(7000);
await shot("studio-test-server");

await page.keyboard.down("KeyW");
await page.waitForTimeout(2200);
await page.keyboard.up("KeyW");
await page.waitForTimeout(800);
await shot("studio-test-walking");

await page.selectOption(".context", "client");
await page.waitForTimeout(1000);
await shot("studio-client-context");

console.log("  output:", await page.evaluate(() =>
  [...document.querySelectorAll(".out")].slice(0, 6).map((e) => e.textContent)));

await page.click(".stop");
await page.waitForTimeout(3000);
await shot("studio-stopped");

// -- done -------------------------------------------------------------------

console.log(
  problems.length
    ? `\nPAGE PROBLEMS:\n - ${problems.slice(0, 8).join("\n - ")}`
    : "\nno page errors",
);

await context.close();
await browser.close();

// Give the recording a name worth keeping.
for (const file of await readdir(OUT)) {
  if (file.endsWith(".webm") && file !== "miblox-walkthrough.webm") {
    await rename(`${OUT}/${file}`, `${OUT}/miblox-walkthrough.webm`);
  }
}
console.log("done");
