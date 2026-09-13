/**
 * Composite a built rig with a deliberately messy fake "colouring" so the masks can be
 * eyeballed. If a part is mispositioned or a mask is wrong, it shows up here long
 * before a phone is involved.
 *
 *   node scripts/previewRig.mjs triceratops out.png
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const [, , slug = "triceratops", out = "rig-preview.png"] = process.argv;
const rig = JSON.parse(readFileSync(resolve(`world/rigs/${slug}.json`), "utf8"));

// Chromium refuses file:// subresources on a setContent page, so inline the PNGs.
const fileUrl = (p) =>
  `data:image/png;base64,${readFileSync(resolve("public" + p)).toString("base64")}`;

/**
 * Stand-in for a child's rectified sheet. Every part samples THIS one image at its own
 * box offset, exactly as the runtime samples the shared canonical texture by UV. If a
 * box is wrong the bands break alignment across the joint and it is obvious.
 */
const TEXTURE =
  "repeating-linear-gradient(115deg," +
  "#e8443a 0 60px,#f2c230 60px 120px,#3aa0e8 120px 180px,#59c24d 180px 240px)";

const layers = rig.parts
  .map(
    (p) => `
  <div style="position:absolute;left:${p.box.x}px;top:${p.box.y}px;
              width:${p.box.w}px;height:${p.box.h}px">
    <div style="position:absolute;inset:0;
                background-image:${TEXTURE};
                background-size:${rig.texture.w}px ${rig.texture.h}px;
                background-position:-${p.box.x}px -${p.box.y}px;
                -webkit-mask:url('${fileUrl(p.mask)}') center/100% 100% no-repeat;
                mask:url('${fileUrl(p.mask)}') center/100% 100% no-repeat"></div>
    <img src="${fileUrl(p.lineart)}" style="position:absolute;inset:0;width:100%;height:100%">
  </div>`,
  )
  .join("");

const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
});
const page = await browser.newPage({
  viewport: { width: rig.texture.w, height: rig.texture.h },
});
await page.setContent(
  `<style>html,body{margin:0;background:#fff}</style>
   <div style="position:relative;width:${rig.texture.w}px;height:${rig.texture.h}px">${layers}</div>`,
  { waitUntil: "load" },
);
await page.waitForTimeout(500);
await page.screenshot({ path: resolve(out) });
await browser.close();
console.log(`${slug} composite -> ${out}`);
