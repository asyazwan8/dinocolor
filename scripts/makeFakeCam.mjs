/**
 * Turn a still image into a Y4M clip, so Chromium's fake capture device can play it
 * as a camera. That lets the real /scan page be driven end to end - viewfinder,
 * shutter, send - rather than only the pipeline underneath it.
 *
 *   node scripts/makeFakeCam.mjs photo.png out.y4m [seconds] [fps]
 *
 * The bundled ffmpeg is a recording-only build with no image decoder, so the frame
 * is decoded in Chromium and the YUV conversion done here.
 */
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [, , input, output, secondsArg = "8", fpsArg = "15"] = process.argv;
if (!input || !output) {
  console.error("usage: node scripts/makeFakeCam.mjs <image> <out.y4m> [seconds] [fps]");
  process.exit(1);
}

const fps = Number(fpsArg);
const frames = Math.max(1, Math.round(Number(secondsArg) * fps));

const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
});
const page = await browser.newPage();
const ext = input.split(".").pop();
const dataUrl = `data:image/${ext};base64,${readFileSync(resolve(input)).toString("base64")}`;

const { width, height, base64 } = await page.evaluate(async (src) => {
  const img = new Image();
  img.src = src;
  await img.decode();
  // Y4M planes need even dimensions for 4:2:0 chroma.
  const w = img.naturalWidth - (img.naturalWidth % 2);
  const h = img.naturalHeight - (img.naturalHeight % 2);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").drawImage(img, 0, 0);
  const data = canvas.getContext("2d").getImageData(0, 0, w, h).data;
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < data.length; i += chunk) {
    binary += String.fromCharCode.apply(null, data.subarray(i, i + chunk));
  }
  return { width: w, height: h, base64: btoa(binary) };
}, dataUrl);
await browser.close();

const rgba = Buffer.from(base64, "base64");
const half = { w: width / 2, h: height / 2 };
const y = Buffer.alloc(width * height);
const u = Buffer.alloc(half.w * half.h);
const v = Buffer.alloc(half.w * half.h);

const clamp = (n) => (n < 0 ? 0 : n > 255 ? 255 : n | 0);

for (let py = 0; py < height; py++) {
  for (let px = 0; px < width; px++) {
    const o = (py * width + px) * 4;
    const r = rgba[o];
    const g = rgba[o + 1];
    const b = rgba[o + 2];
    y[py * width + px] = clamp(0.299 * r + 0.587 * g + 0.114 * b);
  }
}

// Chroma is averaged over each 2x2 block rather than point-sampled, which is what
// keeps fine detail like the QR from developing colour fringes.
for (let cy = 0; cy < half.h; cy++) {
  for (let cx = 0; cx < half.w; cx++) {
    let r = 0;
    let g = 0;
    let b = 0;
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const o = ((cy * 2 + dy) * width + (cx * 2 + dx)) * 4;
        r += rgba[o];
        g += rgba[o + 1];
        b += rgba[o + 2];
      }
    }
    r /= 4;
    g /= 4;
    b /= 4;
    u[cy * half.w + cx] = clamp(-0.169 * r - 0.331 * g + 0.5 * b + 128);
    v[cy * half.w + cx] = clamp(0.5 * r - 0.419 * g - 0.081 * b + 128);
  }
}

const header = Buffer.from(`YUV4MPEG2 W${width} H${height} F${fps}:1 Ip A1:1 C420mpeg2\n`);
const frameMarker = Buffer.from("FRAME\n");
const parts = [header];
for (let i = 0; i < frames; i++) parts.push(frameMarker, y, u, v);

writeFileSync(resolve(output), Buffer.concat(parts));
console.log(`${input} -> ${output} (${width}x${height}, ${frames} frames @ ${fps}fps)`);
