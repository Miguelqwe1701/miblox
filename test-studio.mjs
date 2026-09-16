import { chromium } from "playwright";
const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const problems = [];
page.on("console", (m) => { if (m.type() === "error") problems.push(m.text()); });
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));

await page.goto("http://localhost:3000/studio/baseplate", { waitUntil: "networkidle" });
await page.waitForFunction(() => document.querySelector(".status")?.textContent?.includes("Editing"), { timeout: 30000 });
await page.waitForTimeout(3000);

// Start a test with a character.
await page.click(".test-play");
await page.waitForTimeout(6000);
await page.screenshot({ path: "/home/user/miblox/demo/s10-test-play.png" });

console.log("output lines:", await page.evaluate(() =>
  [...document.querySelectorAll(".out")].slice(0, 12).map((e) => e.textContent)));
console.log("state:", await page.evaluate(() => ({
  testing: document.querySelector("#studio").classList.contains("testing"),
  hasCharacter: !!window.studio?.test?.character,
  contextVisible: !document.querySelector(".context").hidden,
})));

// Walk with WASD.
const before = await page.evaluate(() => {
  const r = window.studio.test.root;
  return [r.CFrame.position.x, r.CFrame.position.z];
});
await page.keyboard.down("KeyW");
await page.waitForTimeout(2500);
await page.keyboard.up("KeyW");
await page.waitForTimeout(500);
const after = await page.evaluate(() => {
  const r = window.studio.test.root;
  return [r.CFrame.position.x, r.CFrame.position.z];
});
console.log("moved from", before.map(Math.round), "to", after.map(Math.round));
await page.screenshot({ path: "/home/user/miblox/demo/s11-test-walking.png" });

// Switch to the client context.
await page.selectOption(".context", "client");
await page.waitForTimeout(800);
await page.screenshot({ path: "/home/user/miblox/demo/s12-client-context.png" });
console.log("status:", await page.textContent(".status"));

// Stop and confirm we are back to editing.
await page.click(".stop");
await page.waitForTimeout(3000);
console.log("after stop:", await page.evaluate(() => ({
  testing: document.querySelector("#studio").classList.contains("testing"),
  status: document.querySelector(".status")?.textContent,
})));
await page.screenshot({ path: "/home/user/miblox/demo/s13-stopped.png" });

console.log(problems.length ? "PROBLEMS: " + problems.slice(0, 5).join(" | ") : "no page errors");
await browser.close();
