import { chromium } from "playwright";
const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const problems = [];
page.on("console", (m) => { if (m.type() === "error") problems.push(m.text()); });
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
// The character adder prompts; answer automatically.
await page.exposeFunction("__noop", () => {});
page.on("dialog", async (d) => d.accept("Template"));
await page.addInitScript(() => {
  window.prompt = (msg, def) => (msg.includes("Whose avatar") ? "Template" : def ?? "");
});

await page.goto("http://localhost:3000/studio/baseplate", { waitUntil: "networkidle" });
await page.waitForFunction(() => document.querySelector(".status")?.textContent?.includes("Editing"), { timeout: 30000 });
await page.waitForTimeout(3000);

console.log("plugin buttons:", await page.evaluate(() =>
  [...document.querySelectorAll(".plugin-button")].map((b) => b.textContent)));

// Use the character adder.
const buttons = await page.$$(".plugin-button");
for (const b of buttons) {
  if ((await b.textContent()) === "Add Template") { await b.click(); break; }
}
await page.waitForTimeout(3000);
await page.screenshot({ path: "/home/user/miblox/demo/s14-character-adder.png" });

console.log("status:", await page.textContent(".status"));
console.log("world:", await page.evaluate(() => {
  const ws = window.studio.game.Workspace;
  const chars = ws.GetChildren().filter((c) => c.FindFirstChildOfClass && c.FindFirstChildOfClass("Humanoid"));
  return chars.map((c) => ({
    name: c.Name,
    accessories: c.GetChildren().filter((x) => x.className === "Accessory").map((x) => x.Name),
    shirt: c.FindFirstChildOfClass("Shirt")?.AssetId,
    pants: c.FindFirstChildOfClass("Pants")?.AssetId,
  }));
}));

// Focus the new character so it fills the frame.
await page.keyboard.press("f");
await page.waitForTimeout(1500);
await page.screenshot({ path: "/home/user/miblox/demo/s15-avatar-closeup.png" });

// The plugin manager.
await page.click(".manage-plugins");
await page.waitForTimeout(700);
await page.screenshot({ path: "/home/user/miblox/demo/s16-plugin-manager.png" });

console.log(problems.length ? "PROBLEMS: " + problems.slice(0, 5).join(" | ") : "no page errors");
await browser.close();
