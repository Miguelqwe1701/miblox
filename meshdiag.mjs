import { chromium } from "playwright";
const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
page.on("pageerror", (e) => console.log("pageerror:", e.message));
await page.goto("http://localhost:3000/avatar", { waitUntil: "networkidle" });
await page.waitForTimeout(3000);
// Put a crown on, so both an accessory mesh and the hair are present.
await page.click('.tab:has-text("Hats")');
await page.waitForTimeout(400);
const hats = await page.$$(".asset");
await hats[3].click();
await page.waitForTimeout(1500);
console.log(await page.evaluate(() => {
  const e = window.avatarEditor;
  const preview = e.preview;
  const out = [];
  preview.worldView.group.traverse((o) => {
    if (!o.isMesh) return;
    const part = o.userData.part;
    if (!part) return;
    out.push({
      name: part.Name,
      className: part.className,
      meshId: part.MeshId ?? null,
      geoVerts: o.geometry.getAttribute("position")?.count ?? 0,
    });
  });
  return out;
}));
await browser.close();
