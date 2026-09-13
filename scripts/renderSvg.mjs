// Render an SVG to PNG so it can actually be looked at. Dev tool, not part of the app.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const [, , inPath, outPath, wArg, hArg] = process.argv;
if (!inPath || !outPath) {
  console.error("usage: node scripts/renderSvg.mjs <in.svg> <out.png> [w] [h]");
  process.exit(1);
}

const width = Number(wArg ?? 1200);
const height = Number(hArg ?? 800);
const svg = readFileSync(resolve(inPath), "utf8");

const browser = await chromium.launch({
  // The image ships Chromium 1194; the npm playwright build expects a newer one.
  // Point at what is actually here rather than downloading a second copy.
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
});
const page = await browser.newPage({ viewport: { width, height } });
await page.setContent(
  `<style>html,body{margin:0;background:#fff}svg{display:block}</style>${svg}`,
  { waitUntil: "load" },
);
await page.screenshot({ path: resolve(outPath) });
await browser.close();
console.log(`rendered ${inPath} -> ${outPath} (${width}x${height})`);
