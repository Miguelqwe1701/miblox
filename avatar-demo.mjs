import { chromium } from "playwright";
const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 850 } });
const problems = [];
page.on("console", (m) => { if (m.type() === "error") problems.push(m.text()); });
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));

await page.goto("http://localhost:3000/avatar", { waitUntil: "networkidle" });
await page.waitForSelector(".asset-grid, .body-panel", { timeout: 20000 });
await page.waitForTimeout(3500);
await page.screenshot({ path: "/home/user/miblox/demo/a1-avatar-body.png" });

// Shirts tab, pick one.
await page.click('.tab:has-text("Shirts")');
await page.waitForTimeout(600);
await page.screenshot({ path: "/home/user/miblox/demo/a2-avatar-shirts.png" });
const shirts = await page.$$(".asset");
await shirts[3].click();
await page.waitForTimeout(1200);

// Pants.
await page.click('.tab:has-text("Pants")');
await page.waitForTimeout(400);
const pants = await page.$$(".asset");
await pants[1].click();
await page.waitForTimeout(800);

// Hat.
await page.click('.tab:has-text("Hats")');
await page.waitForTimeout(400);
const hats = await page.$$(".asset");
await hats[3].click();
await page.waitForTimeout(1500);
await page.screenshot({ path: "/home/user/miblox/demo/a3-avatar-dressed.png" });

console.log("description:", await page.evaluate(() => {
  const e = window.avatarEditor;
  return { shirt: e.description.shirt, pants: e.description.pants, hat: e.description.hatAccessory, hair: e.description.hairAccessory };
}));

// Randomise.
await page.click(".randomise");
await page.waitForTimeout(2000);
await page.screenshot({ path: "/home/user/miblox/demo/a4-avatar-random.png" });

// Saving as a guest should be refused politely.
console.log("save disabled for guest:", await page.evaluate(() => document.querySelector(".save").disabled));
console.log("note:", await page.textContent(".save-note"));

console.log(problems.length ? "PROBLEMS: " + problems.slice(0, 5).join(" | ") : "no page errors");
await browser.close();
