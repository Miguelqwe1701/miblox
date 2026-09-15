import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const OUT = "/home/user/miblox/demo";
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

const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));

const shot = async (name) => {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log("captured", name);
};

await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
await page.waitForSelector(".game-card", { timeout: 15000 });
await page.waitForTimeout(600);
await shot("01-lobby");

// Join the place. The portal launches a game-server process for this.
await page.click(".game-card");
await page.waitForFunction(
  () => document.querySelector(".stats")?.textContent?.includes("Baseplate"),
  { timeout: 30000 },
);
console.log("joined");
await page.waitForTimeout(5000); // let terrain stream in
await shot("02-joined");

// Confirm the WASM mesher is the one running.
const stats = await page.textContent(".stats");
console.log("STATS:\n" + stats);
console.log("platform check:", await page.evaluate(() => ({
  touchControlsVisible: !document.querySelector(".touch-controls").hidden,
  camDistance: Math.round(window.miblox.camera.distance),
  camY: Math.round(window.miblox.camera.camera.position.y),
  rootY: Math.round(window.miblox.simulation.root?.CFrame.position.y ?? 0),
})));

// Look around a bit so the video has motion and the camera shows the world.
await page.mouse.move(720, 405);
for (let i = 0; i < 60; i++) {
  await page.mouse.move(720 + i * 6, 405 + Math.sin(i / 8) * 40);
  await page.waitForTimeout(16);
}
await shot("03-world");

// Walk forward.
await page.keyboard.down("KeyW");
await page.waitForTimeout(2500);
await page.keyboard.up("KeyW");
await page.waitForTimeout(800);
await shot("04-walking");

// Jump.
await page.keyboard.down("Space");
await page.waitForTimeout(150);
await page.keyboard.up("Space");
await page.waitForTimeout(400);
await shot("05-jump");
await page.waitForTimeout(1500);

// Zoom in toward first person.
for (let i = 0; i < 8; i++) {
  await page.mouse.wheel(0, -120);
  await page.waitForTimeout(120);
}
await page.waitForTimeout(800);
await shot("06-zoomed");

// Chat.
await page.click(".chat-input");
await page.type(".chat-input", "hello from the demo");
await page.keyboard.press("Enter");
await page.waitForTimeout(1200);
await shot("07-chat");

// Zoom back out to see the world again.
for (let i = 0; i < 10; i++) {
  await page.mouse.wheel(0, 120);
  await page.waitForTimeout(100);
}
await page.waitForTimeout(1500);
await shot("08-final");

const finalStats = await page.textContent(".stats");
console.log("FINAL STATS:\n" + finalStats);

console.log("\n--- console ---");
for (const line of logs.slice(0, 40)) console.log(line);

await context.close();
await browser.close();
console.log("done");
