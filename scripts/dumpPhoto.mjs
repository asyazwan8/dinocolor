/**
 * Decode an image to raw RGBA so the Node pipeline can be run against a real
 * photograph. Node has no canvas, so Chromium does the decoding.
 *
 *   node scripts/dumpPhoto.mjs photo.png photo.raw
 *
 * Output: an 8-byte little-endian header (width, height) followed by RGBA bytes.
 */
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [, , input, output] = process.argv;
if (!input || !output) {
  console.error("usage: node scripts/dumpPhoto.mjs <image> <out.raw>");
  process.exit(1);
}

const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
});
const page = await browser.newPage();
const dataUrl = `data:image/png;base64,${readFileSync(resolve(input)).toString("base64")}`;

const { width, height, base64 } = await page.evaluate(async (src) => {
  const img = new Image();
  img.src = src;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext("2d").drawImage(img, 0, 0);
  const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < data.length; i += chunk) {
    binary += String.fromCharCode.apply(null, data.subarray(i, i + chunk));
  }
  return { width: canvas.width, height: canvas.height, base64: btoa(binary) };
}, dataUrl);

await browser.close();

const pixels = Buffer.from(base64, "base64");
const header = Buffer.alloc(8);
header.writeUInt32LE(width, 0);
header.writeUInt32LE(height, 4);
writeFileSync(resolve(output), Buffer.concat([header, pixels]));
console.log(`${input} -> ${output} (${width}x${height})`);
