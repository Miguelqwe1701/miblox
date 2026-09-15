import { chromium } from "playwright";
const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
await page.waitForSelector(".game-card");
await page.click(".game-card");
await page.waitForFunction(() => document.querySelector(".stats")?.textContent?.includes("Baseplate"), { timeout: 30000 });
await page.waitForTimeout(6000);

console.log(await page.evaluate(() => {
  const cc = window.miblox;
  const r = cc.simulation.root;
  const focus = { x: r.CFrame.position.x, y: r.CFrame.position.y + 2.5, z: r.CFrame.position.z };
  const dir = { x: 0, y: 0.2474, z: 0.9689 };
  const V3 = r.CFrame.position.constructor;
  const hit = cc.simulation.physics.raycast(
    new V3(focus.x, focus.y, focus.z),
    new V3(dir.x, dir.y, dir.z),
    { maxDistance: 22, filterDescendantsInstances: [r.Parent], filterType: "Exclude" },
  );
  console.log("RAYCAST", JSON.stringify(hit && {
    inst: hit.instance ? hit.instance.Name : "terrain",
    d: +hit.distance.toFixed(2),
    material: hit.material,
    pos: [hit.position.x, hit.position.y, hit.position.z].map((n) => +n.toFixed(1)),
  }));
  console.log("ROOT PARENT", r.Parent ? r.Parent.Name + " / " + r.Parent.className : "none");
  return null;
});
await page.evaluate(() => {
  const c = window.miblox;
  const THREE = c.worldView.group.constructor;
  const cam = c.camera.camera;
  const scene = c.worldView.group.parent;

  // What is directly under the screen centre?
  const ray = new (Object.getPrototypeOf(scene).constructor === Object ? Object : Object)();
  const lighting = c.connection.game.Lighting;
  const sun = c.skyView?.sun;
  const sunDir = lighting.getSunDirection();

  return {
    clockTime: lighting.ClockTime,
    sunDir: [sunDir.x, sunDir.y, sunDir.z].map((n) => +n.toFixed(2)),
    sunIntensity: sun ? +sun.intensity.toFixed(2) : null,
    ambientIntensity: c.skyView ? +c.skyView.ambient.intensity.toFixed(2) : null,
    background: scene.background ? "#" + scene.background.getHexString() : null,
    shadowFrustum: sun ? [sun.shadow.camera.left, sun.shadow.camera.right] : null,
    camPos: [cam.position.x, cam.position.y, cam.position.z].map(Math.round),
    partsNearCentre: (() => {
      const out = [];
      for (const inst of c.connection.game.byId.values()) {
        if (!inst.Size) continue;
        const p = inst.CFrame.position;
        const d = Math.hypot(p.x - cam.position.x, p.y - cam.position.y, p.z - cam.position.z);
        if (d < 40) out.push({ n: inst.Name, cls: inst.className, d: +d.toFixed(1), size: inst.Size.toArray(), color: inst.Color.toHex().toString(16) });
      }
      return out.sort((a, b) => a.d - b.d).slice(0, 10);
    })(),
  };
}));
await browser.close();
