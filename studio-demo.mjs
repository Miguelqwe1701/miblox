import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const OUT = "/home/user/miblox/demo";
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

const problems = [];
page.on("console", (m) => {
  if (m.type() === "error") problems.push(m.text());
});
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));

const shot = async (name) => {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log("captured", name);
};

await page.goto("http://localhost:3000/studio/baseplate", { waitUntil: "networkidle" });
await page.waitForFunction(() => document.querySelector(".status")?.textContent?.includes("Editing"), {
  timeout: 30000,
});
await page.waitForTimeout(4000);
await shot("s1-studio");

// Expand the Workspace node to show the tree.
await page.click(".explorer .node .twisty");
await page.waitForTimeout(500);
await shot("s2-explorer");

// Select a part and inspect its properties.
const nodes = await page.$$(".explorer .node");
for (const node of nodes) {
  const text = await node.textContent();
  if (text?.includes("Baseplate")) {
    await node.click();
    break;
  }
}
await page.waitForTimeout(700);
await shot("s3-properties");

console.log("selection:", await page.evaluate(() => {
  const rows = [...document.querySelectorAll(".prop")].map((r) => r.textContent?.trim());
  return rows.slice(0, 8);
}));

// Insert a part.
await page.selectOption(".insert", "Part");
await page.waitForTimeout(900);
await shot("s4-inserted-part");

// Change its colour via the properties panel.
const colorInput = await page.$('.prop input[type="color"]');
if (colorInput) {
  await colorInput.evaluate((el) => {
    el.value = "#ff8a3d";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
await page.waitForTimeout(700);
await shot("s5-recoloured");

// Terrain sculpting: pick the Add brush and paint.
await page.click('.tool[data-tool="terrain-add"]');
await page.waitForTimeout(400);
await shot("s6-terrain-tool");
for (let i = 0; i < 5; i++) {
  await page.mouse.move(700 + i * 30, 420);
  await page.mouse.down();
  await page.mouse.move(720 + i * 30, 430);
  await page.mouse.up();
  await page.waitForTimeout(500);
}
await page.waitForTimeout(1500);
await shot("s7-sculpted");

// Script editing: select the server script.
await page.click('.tool[data-tool="select"]');
const allNodes = await page.$$(".explorer .node");
for (const node of allNodes) {
  const text = await node.textContent();
  if (text?.includes("ServerScriptService")) {
    await node.$$eval(".twisty", (els) => els[0]?.click());
    break;
  }
}
await page.waitForTimeout(600);
const scriptNodes = await page.$$(".explorer .node");
for (const node of scriptNodes) {
  const text = await node.textContent();
  if (text?.includes("MainScript") || (text?.includes("Main") && text?.includes("Script"))) {
    await node.click();
    break;
  }
}
await page.waitForTimeout(800);
await shot("s8-script-editor");

console.log("script loaded:", await page.evaluate(() => {
  const ta = document.querySelector(".code");
  return { title: document.querySelector(".script-title")?.textContent, length: ta?.value.length ?? 0 };
}));

// Save.
await page.click(".save");
await page.waitForTimeout(2500);
await shot("s9-saved");
console.log("status:", await page.textContent(".status"));

if (problems.length) {
  console.log("\nPAGE PROBLEMS:");
  for (const p of problems.slice(0, 10)) console.log(" -", p);
} else {
  console.log("\nno page errors");
}

await browser.close();
console.log("done");
