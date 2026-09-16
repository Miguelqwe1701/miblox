import { chromium } from "playwright";
const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
const problems = [];
page.on("console", (m) => { if (m.type() === "error") problems.push(m.text()); });
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));

await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
await page.waitForSelector(".enter-lobby", { timeout: 15000 });
await page.waitForTimeout(800);
await page.screenshot({ path: "/home/user/miblox/demo/l1-menu-hero.png" });

await page.click(".enter-lobby");
await page.waitForFunction(() => !document.querySelector(".game")?.hidden, { timeout: 40000 });
await page.waitForTimeout(7000);
await page.screenshot({ path: "/home/user/miblox/demo/l2-lobby.png" });

console.log("in lobby:", await page.evaluate(() => ({
  place: window.miblox.connection.placeName,
  kiosks: !window.miblox.kiosks?.isEmpty,
  parts: window.miblox.worldView.partCount,
})));

// Look around to find a panel.
for (let i = 0; i < 40; i++) {
  await page.mouse.move(720 + i * 4, 405);
  await page.waitForTimeout(20);
}
await page.waitForTimeout(1500);
await page.screenshot({ path: "/home/user/miblox/demo/l3-lobby-panels.png" });

// Aim straight at a panel by driving the camera yaw directly.
const aimed = await page.evaluate(async () => {
  const c = window.miblox;
  // Face the arc of panels.
  c.controls.state.lookYaw = Math.PI;
  c.controls.state.lookPitch = -0.12;
  await new Promise((r) => setTimeout(r, 900));
  return c.aimedAt;
});
console.log("aimed at:", aimed);
await page.waitForTimeout(800);
await page.screenshot({ path: "/home/user/miblox/demo/l4-lobby-aimed.png" });

console.log(problems.length ? "PROBLEMS: " + problems.slice(0, 5).join(" | ") : "no page errors");
await browser.close();
