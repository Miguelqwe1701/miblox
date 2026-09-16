import { chromium } from "playwright";
const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
page.on("pageerror", (e) => console.log("pageerror:", e.message));
page.on("console", (m) => { if (m.type()==="error") console.log("err:", m.text()); });

await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
await page.click(".enter-lobby");
await page.waitForFunction(() => !document.querySelector(".game")?.hidden, undefined, { timeout: 45000 });
await page.waitForTimeout(6000);

for (let i = 0; i < 30 && !(await page.evaluate(() => window.miblox.aimedAt)); i++) {
  await page.mouse.move(720 + i * 8, 405);
  await page.waitForTimeout(60);
}
console.log("aimed:", await page.evaluate(() => window.miblox.aimedAt));

await page.mouse.click(720, 405);
await page.waitForTimeout(3000);
console.log("after click:", await page.evaluate(() => ({
  joining: window.miblox.joining,
  place: window.miblox.connection?.placeName ?? null,
  gameId: window.miblox.currentGameId,
  loadingHidden: document.querySelector(".loading")?.hidden,
  gameHidden: document.querySelector(".game")?.hidden,
  toast: document.querySelector(".toast")?.textContent,
})));
await page.waitForTimeout(8000);
console.log("later:", await page.evaluate(() => ({
  place: window.miblox.connection?.placeName ?? null,
  state: window.miblox.connection?.state ?? null,
  toast: document.querySelector(".toast")?.textContent,
})));
await browser.close();
