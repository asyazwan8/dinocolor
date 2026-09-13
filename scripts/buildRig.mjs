/**
 * Turn one hand-authored SVG into everything the runtime rig needs.
 *
 *   assets/dino/<slug>.svg
 *     -> world/rigs/<slug>.json          bones, pivots, draw order, UV boxes
 *     -> public/assets/masks/<slug>/*    per-part alpha masks
 *     -> public/assets/lineart/<slug>/*  per-part black outlines
 *
 * Parts are cropped to their own bounding box rather than kept full-canvas. A
 * full-canvas quad per part would mean 10 dinos x 8 parts of mostly-empty overdraw
 * every frame; cropping makes fill rate proportional to the ink actually drawn.
 *
 * Interior detail (eye, toes) is clipped to each part's filled region, so details
 * follow the part they sit on without having to be hand-assigned to a bone.
 */
import { chromium } from "playwright";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const CHROMIUM =
  process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

const slug = process.argv[2];
if (!slug) {
  console.error("usage: node scripts/buildRig.mjs <slug>   e.g. triceratops");
  process.exit(1);
}

const svgPath = resolve(`assets/dino/${slug}.svg`);
const svg = readFileSync(svgPath, "utf8");

/** Margin around each cropped part so round joins and caps are never clipped. */
const PAD = 10;

const browser = await chromium.launch({ executablePath: CHROMIUM });
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
await page.setContent(`<style>html,body{margin:0}</style>${svg}`, { waitUntil: "load" });

const meta = await page.evaluate(() => {
  const root = document.querySelector("svg");
  const viewBox = root.getAttribute("viewBox").split(/\s+/).map(Number);
  const parts = [...document.querySelectorAll("#parts > path")].map((el) => {
    const box = el.getBBox();
    const [px, py] = el.dataset.pivot.split(",").map(Number);
    return {
      id: el.id.replace(/^part-/, ""),
      parent: el.dataset.parent || null,
      pivot: { x: px, y: py },
      z: Number(el.dataset.z),
      raw: { x: box.x, y: box.y, w: box.width, h: box.height },
      d: el.getAttribute("d"),
      strokeWidth: Number(
        el.getAttribute("stroke-width") ??
          el.parentElement.getAttribute("stroke-width") ??
          0,
      ),
    };
  });
  const details = [...document.querySelectorAll("#details > *")].map((el) =>
    el.outerHTML,
  );
  return { viewBox, parts, details };
});

const [, , texW, texH] = meta.viewBox;
const detailMarkup = meta.details.join("\n");

const maskDir = resolve(`public/assets/masks/${slug}`);
const lineDir = resolve(`public/assets/lineart/${slug}`);
for (const dir of [maskDir, lineDir]) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

/** getBBox excludes the stroke, so grow the crop by half the stroke plus padding. */
function cropBox(part) {
  const grow = part.strokeWidth / 2 + PAD;
  const x = Math.max(0, Math.floor(part.raw.x - grow));
  const y = Math.max(0, Math.floor(part.raw.y - grow));
  return {
    x,
    y,
    w: Math.min(texW - x, Math.ceil(part.raw.w + grow * 2)),
    h: Math.min(texH - y, Math.ceil(part.raw.h + grow * 2)),
  };
}

async function shoot(markup, box, outPath) {
  await page.setViewportSize({ width: box.w, height: box.h });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{display:block}</style>
     <svg xmlns="http://www.w3.org/2000/svg" width="${box.w}" height="${box.h}"
          viewBox="${box.x} ${box.y} ${box.w} ${box.h}">${markup}</svg>`,
    { waitUntil: "load" },
  );
  await page.screenshot({ path: outPath, omitBackground: true });
}

const parts = [];
for (const part of meta.parts) {
  const box = cropBox(part);
  const stroke = part.strokeWidth;

  // Mask: silhouette including the outline, so the stroke belongs to the part.
  await shoot(
    `<path d="${part.d}" fill="#000" stroke="#000" stroke-width="${stroke}"
           stroke-linejoin="round" stroke-linecap="round"/>`,
    box,
    `${maskDir}/${part.id}.png`,
  );

  // Line art: this part's outline, plus any detail strokes falling inside it.
  await shoot(
    `<defs><clipPath id="c"><path d="${part.d}"/></clipPath></defs>
     <g clip-path="url(#c)" fill="none" stroke="#111111" stroke-width="5"
        stroke-linejoin="round" stroke-linecap="round">${detailMarkup}</g>
     <path d="${part.d}" fill="none" stroke="#111111" stroke-width="${stroke}"
           stroke-linejoin="round" stroke-linecap="round"/>`,
    box,
    `${lineDir}/${part.id}.png`,
  );

  parts.push({
    id: part.id,
    parent: part.parent,
    pivot: part.pivot,
    z: part.z,
    box,
    mask: `/assets/masks/${slug}/${part.id}.png`,
    lineart: `/assets/lineart/${slug}/${part.id}.png`,
  });
}

await browser.close();

parts.sort((a, b) => a.z - b.z);

const byId = new Set(parts.map((p) => p.id));
for (const p of parts) {
  if (p.parent && !byId.has(p.parent)) {
    throw new Error(`part "${p.id}" names unknown parent "${p.parent}"`);
  }
}
const roots = parts.filter((p) => !p.parent);
if (roots.length !== 1) {
  throw new Error(`expected exactly one root part, found ${roots.length}`);
}

mkdirSync(resolve("world/rigs"), { recursive: true });
const outPath = resolve(`world/rigs/${slug}.json`);
writeFileSync(
  outPath,
  `${JSON.stringify({ slug, texture: { w: texW, h: texH }, parts }, null, 2)}\n`,
);

console.log(`${slug}: ${parts.length} parts -> ${outPath}`);
for (const p of parts) {
  console.log(
    `  z${p.z} ${p.id.padEnd(14)} parent=${String(p.parent).padEnd(6)} ` +
      `box=${p.box.w}x${p.box.h} @${p.box.x},${p.box.y}`,
  );
}
