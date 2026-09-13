/**
 * The whole installation, end to end, without a phone.
 *
 * Prints a sheet, colours it in, photographs it at an angle, runs the real capture
 * pipeline, pushes the result through the real relay, and screenshots the screen.
 * Only the camera itself is simulated; every other step is the shipping code.
 *
 *   node scripts/e2eLoop.mjs [baseUrl]
 */
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const BASE = process.argv[2] ?? "http://localhost:3000";
const OUT = process.env.SHOT_DIR ?? ".";
const SESSION = "loop";

const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
});

// 1. Print the sheet.
const printer = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
await printer.goto(`${BASE}/print/triceratops`, { waitUntil: "networkidle" });
const blank = await printer.locator(".sheet").screenshot();
await printer.close();

// 2. Colour it in, enthusiastically and well outside the lines.
const colourist = await browser.newPage({ viewport: { width: 1240, height: 880 } });
await colourist.setContent(
  `<style>html,body{margin:0}canvas{display:block}</style><canvas id="c"></canvas>`,
  { waitUntil: "load" },
);
const colouredDataUrl = await colourist.evaluate(async (sheetB64) => {
  const img = new Image();
  img.src = sheetB64;
  await img.decode();
  const c = document.getElementById("c");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);

  // Multiply, so crayon sits under the printed outline the way wax does on paper.
  ctx.globalCompositeOperation = "multiply";
  ctx.globalAlpha = 0.75;
  ctx.lineCap = "round";
  const areas = [
    [0.34, 0.5, 0.26, 0.22, "#d6453a"],
    [0.62, 0.38, 0.2, 0.26, "#f0a52c"],
    [0.32, 0.72, 0.3, 0.16, "#3f8fd0"],
    [0.2, 0.52, 0.14, 0.1, "#5fb35a"],
    [0.55, 0.72, 0.14, 0.14, "#8a56c0"],
  ];
  for (const [fx, fy, fw, fh, colour] of areas) {
    ctx.strokeStyle = colour;
    const cx = fx * c.width;
    const cy = fy * c.height;
    const w = fw * c.width;
    const h = fh * c.height;
    for (let i = 0; i < 260; i++) {
      const x = cx + (Math.random() - 0.5) * w;
      const y = cy + (Math.random() - 0.5) * h;
      ctx.lineWidth = 7 + Math.random() * 9;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + 18 + Math.random() * 40, y - 12 - Math.random() * 30);
      ctx.stroke();
    }
  }
  return c.toDataURL("image/png");
}, `data:image/png;base64,${blank.toString("base64")}`);
await colourist.close();

// 3. Photograph it at an angle, on a table, under uneven light.
const shooter = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
await shooter.setContent(
  `<style>
     html,body{margin:0;height:100%;overflow:hidden}
     .room{position:absolute;inset:0;display:grid;place-items:center;
           background:radial-gradient(circle at 25% 15%, #8d8377, #443f39)}
     img{width:1180px;transform:perspective(1300px) rotateX(13deg) rotateY(-15deg) rotateZ(3deg);
         box-shadow:0 26px 54px rgba(0,0,0,.45)}
     .glare{position:absolute;inset:0;pointer-events:none;
            background:linear-gradient(118deg, rgba(255,244,214,.22), rgba(255,255,255,0) 52%)}
   </style>
   <div class="room"><img src="${colouredDataUrl}"></div><div class="glare"></div>`,
  { waitUntil: "load" },
);
await shooter.waitForTimeout(350);
const photo = await shooter.screenshot();
writeFileSync(`${OUT}/loop-1-photo.png`, photo);
await shooter.close();

// 4. Run the real capture pipeline on that photograph.
const harness = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
await harness.goto(`${BASE}/dev/rectify`, { waitUntil: "networkidle" });
await harness
  .locator('input[type="file"]')
  .setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: photo });
await harness.waitForTimeout(2500);

const summary = await harness.locator("section").first().innerText();
console.log("capture:", summary.replace(/\n/g, " | "));
if (!summary.includes("Captured")) {
  console.error("capture failed, stopping");
  await browser.close();
  process.exit(1);
}

const texture = await harness.evaluate(() =>
  document.querySelectorAll("canvas")[1].toDataURL("image/webp", 0.82),
);
writeFileSync(
  `${OUT}/loop-2-rectified.png`,
  await harness.locator("canvas").nth(1).screenshot(),
);
await harness.close();

console.log("texture bytes:", Math.round((texture.length * 3) / 4 / 1024), "KB");

// 5. Push it through the real relay, exactly as the scan page would.
const response = await fetch(`${BASE}/api/submit`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ session: SESSION, dino: "TRI", serial: "0001", texture }),
});
console.log("relay:", response.status, await response.text());

// 6. The screen should now be showing that child's dinosaur.
const screen = await browser.newPage({ viewport: { width: 1600, height: 900 } });
screen.on("console", (m) => console.log(`  [screen ${m.type()}]`, m.text().slice(0, 200)));
screen.on("pageerror", (e) => console.log("  [screen error]", String(e).slice(0, 300)));
await screen.goto(`${BASE}/screen?s=${SESSION}`, { waitUntil: "networkidle" });
await screen.waitForTimeout(9000);
writeFileSync(`${OUT}/loop-3-screen.png`, await screen.screenshot());
await screen.close();

await browser.close();
console.log("loop complete");
