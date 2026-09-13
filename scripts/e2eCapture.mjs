/**
 * End-to-end check against the REAL print route.
 *
 * The unit tests build their own synthetic sheet, so they verify the pipeline but
 * not that the printed page actually matches the geometry contract. This renders
 * /print, photographs it through a CSS perspective transform to fake a hand-held
 * phone, and pushes that through the real /dev/rectify harness.
 *
 *   node scripts/e2eCapture.mjs [baseUrl]
 */
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const BASE = process.argv[2] ?? "http://localhost:3000";
const OUT = process.env.SHOT_DIR ?? ".";

const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
});

/** Camera angles to try, as CSS 3D rotations of the sheet. */
const ANGLES = [
  { name: "flat", css: "none" },
  { name: "tilted", css: "perspective(1600px) rotateX(9deg) rotateY(-11deg) rotateZ(2deg)" },
  { name: "steep", css: "perspective(1100px) rotateX(17deg) rotateY(19deg) rotateZ(-4deg)" },
];

const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
await page.goto(`${BASE}/print/triceratops`, { waitUntil: "networkidle" });
const sheetShot = await page.locator(".sheet").screenshot();
writeFileSync(`${OUT}/e2e-sheet.png`, sheetShot);

const sheetDataUrl = `data:image/png;base64,${sheetShot.toString("base64")}`;
let failures = 0;

for (const angle of ANGLES) {
  // Photograph the sheet: lay it on a surface, tilt it, light it unevenly.
  const shooter = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
  await shooter.setContent(
    `<style>
       html,body{margin:0;height:100%;background:#6b6257;overflow:hidden}
       .room{position:absolute;inset:0;display:grid;place-items:center;
             background:radial-gradient(circle at 30% 20%, #8d8377, #4c4640)}
       img{width:1180px;transform:${angle.css};box-shadow:0 30px 60px rgba(0,0,0,.45)}
       .glare{position:absolute;inset:0;pointer-events:none;
              background:linear-gradient(115deg, rgba(255,245,220,.20), rgba(255,255,255,0) 55%)}
     </style>
     <div class="room"><img src="${sheetDataUrl}"></div><div class="glare"></div>`,
    { waitUntil: "load" },
  );
  await shooter.waitForTimeout(300);
  const photo = await shooter.screenshot();
  writeFileSync(`${OUT}/e2e-photo-${angle.name}.png`, photo);
  await shooter.close();

  const harness = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
  await harness.goto(`${BASE}/dev/rectify`, { waitUntil: "networkidle" });
  await harness
    .locator('input[type="file"]')
    .setInputFiles({ name: `${angle.name}.png`, mimeType: "image/png", buffer: photo });
  await harness.waitForTimeout(2500);

  const summary = await harness.locator("section").first().innerText().catch(() => "(no result)");
  const ok = summary.includes("Captured");
  if (!ok) failures++;
  console.log(`\n[${angle.name}] ${ok ? "PASS" : "FAIL"}`);
  console.log(summary.split("\n").map((l) => "   " + l).join("\n"));

  if (ok) {
    const rectified = await harness.locator("canvas").nth(1).screenshot();
    writeFileSync(`${OUT}/e2e-rectified-${angle.name}.png`, rectified);
  }
  await harness.close();
}

await browser.close();
console.log(`\n${ANGLES.length - failures}/${ANGLES.length} angles captured`);
process.exit(failures ? 1 : 0);
