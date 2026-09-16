/**
 * Records a trailer for MiBlox.
 *
 * Unlike demo.mjs, which walks through features one screenshot at a time, this
 * drives the game's own cinematic camera: every move here is a CameraShot the
 * engine eases through, and the character is walking under player input while
 * it happens. Nothing is mocked or composited - it is a recording of a real
 * browser session against a real game server.
 *
 *   npm run build && npm run place:build && npm run portal restart
 *   node trailer.mjs
 */
import { chromium } from "playwright";
import { mkdir, rename, rm } from "node:fs/promises";

const OUT = "/home/user/miblox/demo";
const PORTAL = "http://localhost:3000";
const SIZE = { width: 1280, height: 720 };
await mkdir(OUT, { recursive: true });

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
  viewport: SIZE,
  deviceScaleFactor: 1,
  recordVideo: { dir: OUT, size: SIZE },
});
const page = await context.newPage();

const problems = [];
page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
page.on("response", (r) => r.status() === 404 && problems.push(`404 ${r.url()}`));

// A caption layer, injected before any page script runs so it survives the
// navigations between the game, the avatar editor and the studio.
await page.addInitScript(() => {
  window.__caption = (text, sub = "", where = "top") => {
    let el = document.getElementById("trailer-caption");
    if (!el) {
      el = document.createElement("div");
      el.id = "trailer-caption";
      el.style.cssText = [
        "position:fixed",
        "left:0",
        "right:0",
        "top:7%",
        "bottom:auto",
        "z-index:99999",
        "text-align:center",
        "pointer-events:none",
        "font-family:system-ui,sans-serif",
        "opacity:0",
        "transition:opacity .5s ease",
        "text-shadow:0 2px 18px rgba(0,0,0,.85)",
      ].join(";");
      document.body.appendChild(el);
    }
    if (!text) {
      el.style.opacity = "0";
      return;
    }
    // Studio has its own toolbars along the top, so captions go under them.
    el.style.top = where === "top" ? "7%" : "auto";
    el.style.bottom = where === "top" ? "auto" : "6%";
    el.innerHTML =
      `<div style="font-size:40px;font-weight:650;color:#fff;letter-spacing:-.5px">${text}</div>` +
      (sub ? `<div style="font-size:19px;color:#cfe0ff;margin-top:6px">${sub}</div>` : "");
    el.style.opacity = "1";
  };
  window.prompt = (msg, def) => (msg.includes("Whose avatar") ? "Template" : def ?? "");
});

const caption = (text, sub, where = "top") =>
  page.evaluate(([t, s, w]) => window.__caption(t, s, w), [text, sub ?? "", where]);
const clearCaption = () => page.evaluate(() => window.__caption(""));
const wait = (ms) => page.waitForTimeout(ms);
const beat = (text) => console.log(`\n${text}`);

/** Plays a sequence of camera shots and waits for the last one to land. */
const cinematic = (shots) =>
  page.evaluate(
    (shots) =>
      window.miblox.camera.cinematic.play(
        shots.map((s) => ({
          ...s,
          follow: s.follow === "me" ? window.miblox.simulation.root : null,
        })),
      ),
    shots,
  );
const freeCamera = () => page.evaluate(() => window.miblox.camera.cinematic.stop());

let stillNumber = 0;
/** A frame from the trailer, kept as a still so the shots can be checked. */
const still = async (name) => {
  stillNumber += 1;
  const file = `trailer-${String(stillNumber).padStart(2, "0")}-${name}`;
  await page.screenshot({ path: `${OUT}/${file}.png` });
  console.log("  still", file);
};

// -- the menu ---------------------------------------------------------------

beat("Menu");
await page.goto(PORTAL, { waitUntil: "networkidle" });
await page.waitForSelector(".enter-lobby", { timeout: 20000 });
await wait(1600);

// -- the lobby --------------------------------------------------------------

beat("Lobby: a world you join, not a web page");
await page.click(".enter-lobby");
await page.waitForFunction(() => !document.querySelector(".game")?.hidden, undefined, {
  timeout: 45000,
});
await page.waitForFunction(() => window.miblox?.simulation?.root, undefined, { timeout: 45000 });
await wait(4500);

await caption("MiBlox", "A world you join, not a menu you click through");
const lobbyOrbit = cinematic([
  {
    duration: 7,
    follow: "me",
    orbit: true,
    eye: [
      [0, 9, 26],
      [24, 7, -12],
    ],
    target: [
      [0, 2, 0],
      [0, 2, 0],
    ],
    fov: [55, 68],
    ease: "inOut",
  },
]);
await wait(3000);
await still("lobby-orbit");
await lobbyOrbit;
await clearCaption();

beat("Joining a world from inside the lobby");
await freeCamera();
await wait(400);
/** Sweeps the pointer until a kiosk is under it, and reports where it landed. */
const findKiosk = async () => {
  for (let i = 0; i < 40; i++) {
    const x = 640 + i * 8;
    await page.mouse.move(x, 360);
    await wait(60);
    if (await page.evaluate(() => window.miblox.aimedAt)) return { x, y: 360 };
  }
  return null;
};
let kiosk = await findKiosk();
console.log("  pointing at:", await page.evaluate(() => window.miblox.aimedAt));
await caption("Pick a game from inside the lobby", "No headset off, no back to the desktop");
await wait(1600);
// The camera drifts while the caption is up, so confirm the kiosk is still
// under the pointer rather than clicking where it used to be.
if (!(await page.evaluate(() => window.miblox.aimedAt))) kiosk = await findKiosk();
if (!kiosk) throw new Error("no kiosk under the pointer to click");
await page.mouse.click(kiosk.x, kiosk.y);
await page.waitForFunction(
  () => window.miblox?.connection?.placeName === "Baseplate",
  undefined,
  { timeout: 60000 },
);
await clearCaption();
await page.waitForFunction(() => window.miblox?.simulation?.root, undefined, { timeout: 45000 });
await wait(6000);

// -- the world --------------------------------------------------------------

beat("Establishing shot: smooth voxel terrain");
await caption("Smooth voxel terrain", "Meshed in WebAssembly, the same code the server runs");
const establishing = cinematic([
  {
    duration: 7,
    follow: "me",
    eye: [
      [110, 95, 150],
      [14, 14, 34],
    ],
    target: [
      [0, 6, 0],
      [0, 2, 0],
    ],
    ease: "inOut",
    fov: [70, 62],
  },
]);
await wait(2500);
await still("establishing");
await establishing;
await still("arrived");
await clearCaption();

beat("Tracking shot: walking, with the walk cycle running");
await caption("Every character animates", "Procedural R6 - no animation downloads");
const walking = cinematic([
  {
    duration: 9,
    follow: "me",
    eye: [
      [13, 4.5, 9],
      [-11, 5.5, 8],
    ],
    target: [
      [0, 1.5, 0],
      [0, 1.5, 0],
    ],
    ease: "linear",
  },
]);
await page.keyboard.down("KeyW");
await wait(2000);
await still("walking");
await wait(2200);
await page.keyboard.down("Space");
await wait(140);
await page.keyboard.up("Space");
await wait(260);
await still("jumping");
await wait(2700);
await page.keyboard.up("KeyW");
await walking;
await clearCaption();

beat("Close orbit: the rig, the clothes, the hat");
await caption("Hats, hair, shirts and pants", "All from a HumanoidDescription");
const closeOrbit = cinematic([
  {
    duration: 7,
    follow: "me",
    orbit: true,
    eye: [
      [0, 3.5, 14],
      [0, 4.5, -14],
    ],
    target: [
      [0, 0.4, 0],
      [0, 0.6, 0],
    ],
    fov: [48, 48],
    ease: "inOut",
  },
]);
await wait(1800);
await still("close-front");
await wait(2600);
await still("close-side");
await closeOrbit;
await clearCaption();

// -- building ---------------------------------------------------------------

beat("Building and digging");
await freeCamera();
await wait(500);
await caption("Build and dig, live", "Terrain edits replicate to everyone in the server");
await page.keyboard.press("3");
await wait(400);
for (let i = 0; i < 9; i++) {
  await page.mouse.click(640, 400);
  await wait(200);
}
await wait(600);
for (let i = 0; i < 5; i++) {
  await page.mouse.click(600, 420, { button: "right" });
  await wait(200);
}
await wait(900);
await still("built");
await clearCaption();

await cinematic([
  {
    duration: 6,
    follow: "me",
    orbit: true,
    eye: [
      [-14, 6, 14],
      [16, 8, 12],
    ],
    target: [
      [0, 2, -6],
      [0, 2, -6],
    ],
    ease: "inOut",
  },
]);
await freeCamera();

// -- scripting --------------------------------------------------------------

beat("Luau: chat");
await caption("Servers run Luau", "Scripts, coroutines, task.wait - the real thing");
await page.keyboard.press("Enter");
await wait(250);
await page.keyboard.type("made of blocks");
await page.keyboard.press("Enter");
await wait(1200);
await still("chat");
await wait(1000);
await clearCaption();

// -- the avatar editor ------------------------------------------------------

beat("Avatar editor");
await page.goto(`${PORTAL}/avatar`, { waitUntil: "networkidle" });
await page.waitForSelector(".body-panel", { timeout: 20000 });
await wait(3000);
await caption("Dress your avatar", "Catalogue ids, saved as a HumanoidDescription");

/** Clicks a catalogue item by the name printed on it. */
const wear = async (tab, item) => {
  await page.locator(`button.tab:text-is("${tab}")`).first().click().catch(() => {});
  await wait(900);
  const clicked = await page
    .locator(`button.asset:has(.asset-name:text-is("${item}"))`)
    .first()
    .click()
    .then(() => true)
    .catch(() => false);
  console.log(`  ${clicked ? "wore" : "could not find"} ${item}`);
  await wait(1600);
};
await wear("Hats", "Top Hat");
await wear("Shirts", "Team Jersey");
await wait(1500);
await still("avatar");
await wait(1200);
await clearCaption();

// -- studio -----------------------------------------------------------------

beat("Studio");
await page.goto(`${PORTAL}/studio/baseplate`, { waitUntil: "networkidle" });
await page.waitForFunction(
  () => document.querySelector(".status")?.textContent?.includes("Editing"),
  undefined,
  { timeout: 45000 },
);
await wait(4500);
await caption("A studio in the browser", "Sculpt terrain, edit scripts, run a test server", "bottom");

await page.click('.tool[data-tool="terrain-add"]');
await wait(400);
for (let i = 0; i < 6; i++) {
  await page.mouse.move(560 + i * 40, 380);
  await page.mouse.down();
  await page.mouse.move(590 + i * 40, 400);
  await page.mouse.up();
  await wait(380);
}
await wait(1200);
await still("studio-sculpting");
await page.click('.tool[data-tool="select"]');
await clearCaption();

beat("Studio: a real test server");
await caption("Press play for a real server", "Its scripts run in the same Luau the game servers use", "bottom");
await page.click(".test-play");
await wait(6500);
await still("studio-test-server");
await page.keyboard.down("KeyW");
await wait(2000);
await page.keyboard.up("KeyW");
await wait(1200);
await still("studio-test-walking");
await page.click(".stop");
await wait(2000);
await clearCaption();

await page.goto(PORTAL, { waitUntil: "networkidle" });
await wait(1500);
await caption("MiBlox", "Browser, desktop, phone and VR");
await wait(3500);
await still("title");
await clearCaption();
await wait(1200);

console.log(problems.length ? `\npage problems:\n${problems.join("\n")}` : "\nno page errors");

// Playwright only finalises the file when the context closes.
const videoPath = await page.video().path();
await context.close();
await browser.close();

await rm(`${OUT}/miblox-trailer.webm`, { force: true });
await rename(videoPath, `${OUT}/miblox-trailer.webm`);
console.log("wrote demo/miblox-trailer.webm");
