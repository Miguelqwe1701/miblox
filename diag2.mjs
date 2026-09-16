import { chromium } from "playwright";
const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
page.on("console", (m) => console.log("PAGE:", m.text()));
await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
await page.waitForSelector(".game-card");
await page.click(".game-card");
await page.waitForFunction(() => document.querySelector(".stats")?.textContent?.includes("Baseplate"), { timeout: 30000 });
await page.waitForTimeout(6000);
await page.evaluate(() => {
  const c = window.miblox;
  const r = c.simulation.root;
  const V3 = r.CFrame.position.constructor;
  const focus = new V3(r.CFrame.position.x, r.CFrame.position.y + 2.5, r.CFrame.position.z);
  const dir = new V3(0, 0.2474, 0.9689);
  const hit = c.simulation.physics.raycast(focus, dir, {
    maxDistance: 22,
    filterDescendantsInstances: [r.Parent],
    filterType: "Exclude",
  });
  console.log("ROOT PARENT: " + (r.Parent ? r.Parent.Name + " (" + r.Parent.className + ")" : "none"));
  console.log("RAYCAST: " + JSON.stringify(hit && {
    inst: hit.instance ? hit.instance.Name : "TERRAIN",
    d: +hit.distance.toFixed(2),
    material: hit.material,
  }));
  console.log("CAM: " + JSON.stringify([c.camera.camera.position.x, c.camera.camera.position.y, c.camera.camera.position.z].map(n => +n.toFixed(1))));
});
await browser.close();
