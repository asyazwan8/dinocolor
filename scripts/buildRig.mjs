/**
 * Turn printed artwork plus a rig definition into everything the runtime needs.
 *
 *   assets/dino/<slug>.svg          part polygons + a reference to the artwork
 *   public/assets/dino/<slug>.png   the printed drawing
 *     -> world/rigs/<slug>.json          bones, pivots, draw order, UV boxes
 *     -> public/assets/masks/<slug>/*    per-part alpha masks
 *     -> public/assets/lineart/<slug>/*  per-part slices of the drawing
 *
 * The silhouette is derived from the artwork rather than traced by hand. Flooding
 * inward from the border marks everything the flood can reach as paper; what it
 * cannot reach is the dinosaur, ink and enclosed white alike. Each part's mask is
 * that silhouette intersected with its polygon, so the outer edge always follows the
 * printed line exactly and the polygons only decide which bone owns which region.
 *
 * Parts are cropped to the bounding box of their actual mask pixels, not of their
 * polygon: a full-canvas quad per part would be mostly-empty overdraw every frame.
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

const CANVAS = { w: 1200, h: 800 };
/** Anything at least this bright counts as paper for the flood. */
const PAPER_LEVEL = 232;
/** Margin around each cropped part so nothing is clipped at the edge. */
const PAD = 6;
/** Above this luminance the drawing is paper, and drops out of the ink layer. */
const INK_FLOOR = 238;

const svg = readFileSync(resolve(`assets/dino/${slug}.svg`), "utf8");
const artworkSrc = /data-artwork="([^"]+)"/.exec(svg)?.[1];
if (!artworkSrc) throw new Error(`${slug}.svg has no data-artwork attribute`);

const artworkPath = resolve(`public${artworkSrc}`);
const artworkExt = artworkSrc.split(".").pop();
const artworkDataUrl = `data:image/${artworkExt === "png" ? "png" : artworkExt};base64,${readFileSync(
  artworkPath,
).toString("base64")}`;

const browser = await chromium.launch({ executablePath: CHROMIUM });
const page = await browser.newPage({ viewport: { width: CANVAS.w, height: CANVAS.h } });
await page.setContent(`<style>html,body{margin:0}</style>${svg}`, { waitUntil: "load" });

const parts = await page.evaluate(() =>
  [...document.querySelectorAll("#parts > polygon")].map((el) => {
    const [px, py] = el.dataset.pivot.split(",").map(Number);
    return {
      id: el.id.replace(/^part-/, ""),
      parent: el.dataset.parent || null,
      pivot: { x: px, y: py },
      z: Number(el.dataset.z),
      points: el.getAttribute("points"),
    };
  }),
);

const built = await page.evaluate(
  async ({ parts, artworkDataUrl, CANVAS, PAPER_LEVEL, PAD, INK_FLOOR }) => {
    const art = new Image();
    art.src = artworkDataUrl;
    await art.decode();

    // Fit the artwork inside the canonical box, centred, preserving aspect.
    const scale = Math.min(CANVAS.w / art.naturalWidth, CANVAS.h / art.naturalHeight);
    const placement = {
      w: art.naturalWidth * scale,
      h: art.naturalHeight * scale,
      x: (CANVAS.w - art.naturalWidth * scale) / 2,
      y: (CANVAS.h - art.naturalHeight * scale) / 2,
    };

    const make = (w, h) => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      return [c, c.getContext("2d", { willReadFrequently: true })];
    };

    const [artCanvas, artCtx] = make(CANVAS.w, CANVAS.h);
    artCtx.fillStyle = "#fff";
    artCtx.fillRect(0, 0, CANVAS.w, CANVAS.h);
    artCtx.drawImage(art, placement.x, placement.y, placement.w, placement.h);
    const pixels = artCtx.getImageData(0, 0, CANVAS.w, CANVAS.h).data;

    // Flood from the border across paper. Whatever it cannot reach is the drawing.
    const outside = new Uint8Array(CANVAS.w * CANVAS.h);
    const stack = [];
    const isPaper = (i) => {
      const o = i * 4;
      return (pixels[o] + pixels[o + 1] + pixels[o + 2]) / 3 >= PAPER_LEVEL;
    };
    for (let x = 0; x < CANVAS.w; x++) {
      stack.push(x, (CANVAS.h - 1) * CANVAS.w + x);
    }
    for (let y = 0; y < CANVAS.h; y++) {
      stack.push(y * CANVAS.w, y * CANVAS.w + CANVAS.w - 1);
    }
    while (stack.length) {
      const i = stack.pop();
      if (outside[i] || !isPaper(i)) continue;
      outside[i] = 1;
      const x = i % CANVAS.w;
      if (x > 0) stack.push(i - 1);
      if (x < CANVAS.w - 1) stack.push(i + 1);
      if (i >= CANVAS.w) stack.push(i - CANVAS.w);
      if (i < CANVAS.w * (CANVAS.h - 1)) stack.push(i + CANVAS.w);
    }

    const [silCanvas, silCtx] = make(CANVAS.w, CANVAS.h);
    const sil = silCtx.createImageData(CANVAS.w, CANVAS.h);
    let silhouettePixels = 0;
    for (let i = 0; i < outside.length; i++) {
      if (outside[i]) continue;
      sil.data[i * 4 + 3] = 255;
      silhouettePixels++;
    }
    silCtx.putImageData(sil, 0, 0);

    const claimed = new Uint8Array(CANVAS.w * CANVAS.h);
    const results = [];

    for (const part of parts) {
      // Polygon, clipped down to the silhouette.
      const [maskFull, maskCtx] = make(CANVAS.w, CANVAS.h);
      maskCtx.fillStyle = "#000";
      maskCtx.beginPath();
      part.points
        .trim()
        .split(/\s+/)
        .forEach((pair, i) => {
          const [px, py] = pair.split(",").map(Number);
          if (i === 0) maskCtx.moveTo(px, py);
          else maskCtx.lineTo(px, py);
        });
      maskCtx.closePath();
      maskCtx.fill();
      maskCtx.globalCompositeOperation = "destination-in";
      maskCtx.drawImage(silCanvas, 0, 0);

      // Tight crop around the pixels that actually survived.
      const data = maskCtx.getImageData(0, 0, CANVAS.w, CANVAS.h).data;
      let minX = CANVAS.w;
      let minY = CANVAS.h;
      let maxX = -1;
      let maxY = -1;
      for (let y = 0; y < CANVAS.h; y++) {
        for (let x = 0; x < CANVAS.w; x++) {
          const i = y * CANVAS.w + x;
          if (!data[i * 4 + 3]) continue;
          claimed[i] = 1;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
      if (maxX < 0) throw new Error(`part "${part.id}" claims no pixels of the drawing`);

      const box = {
        x: Math.max(0, minX - PAD),
        y: Math.max(0, minY - PAD),
        w: 0,
        h: 0,
      };
      box.w = Math.min(CANVAS.w - box.x, maxX - minX + 1 + PAD * 2);
      box.h = Math.min(CANVAS.h - box.y, maxY - minY + 1 + PAD * 2);

      const [maskOut, maskOutCtx] = make(box.w, box.h);
      maskOutCtx.drawImage(maskFull, -box.x, -box.y);

      // This part's slice of the printed drawing, reduced to ink.
      //
      // The artwork is black lines on white, and that white is opaque - composited
      // over a child's colouring it would hide it completely. So the paper is turned
      // transparent and the line kept, with alpha taken from how dark each pixel is,
      // which preserves the anti-aliasing along every edge for free.
      const [lineOut, lineOutCtx] = make(box.w, box.h);
      lineOutCtx.drawImage(artCanvas, -box.x, -box.y);
      const line = lineOutCtx.getImageData(0, 0, box.w, box.h);
      for (let i = 0; i < line.data.length; i += 4) {
        const lum = (line.data[i] + line.data[i + 1] + line.data[i + 2]) / 3;
        // Anything at or above INK_FLOOR is paper and drops out entirely; below it,
        // alpha ramps up so the softened edge of a stroke stays soft.
        line.data[i] = 17;
        line.data[i + 1] = 17;
        line.data[i + 2] = 17;
        line.data[i + 3] = lum >= INK_FLOOR ? 0 : Math.round(((INK_FLOOR - lum) / INK_FLOOR) * 255);
      }
      lineOutCtx.putImageData(line, 0, 0);
      lineOutCtx.globalCompositeOperation = "destination-in";
      lineOutCtx.drawImage(maskOut, 0, 0);

      results.push({
        ...part,
        box,
        mask: maskOut.toDataURL("image/png"),
        lineart: lineOut.toDataURL("image/png"),
      });
    }

    // Debug view: the drawing, greyed, with anything no part claimed picked out in
    // red. Far quicker than reasoning about which polygon fell short.
    const [dbg, dbgCtx] = make(CANVAS.w, CANVAS.h);
    dbgCtx.globalAlpha = 0.28;
    dbgCtx.drawImage(artCanvas, 0, 0);
    dbgCtx.globalAlpha = 1;
    const overlay = dbgCtx.createImageData(CANVAS.w, CANVAS.h);
    let unclaimed = 0;
    for (let i = 0; i < outside.length; i++) {
      if (outside[i] || claimed[i]) continue;
      unclaimed++;
      overlay.data[i * 4] = 230;
      overlay.data[i * 4 + 3] = 255;
    }
    const [ov, ovCtx] = make(CANVAS.w, CANVAS.h);
    ovCtx.putImageData(overlay, 0, 0);
    dbgCtx.drawImage(ov, 0, 0);

    return { results, placement, silhouettePixels, unclaimed, debug: dbg.toDataURL("image/png") };
  },
  { parts, artworkDataUrl, CANVAS, PAPER_LEVEL, PAD, INK_FLOOR },
);

await browser.close();

const maskDir = resolve(`public/assets/masks/${slug}`);
const lineDir = resolve(`public/assets/lineart/${slug}`);
for (const dir of [maskDir, lineDir]) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

const decode = (dataUrl) => Buffer.from(dataUrl.split(",")[1], "base64");

const rigParts = built.results
  .map((part) => {
    writeFileSync(`${maskDir}/${part.id}.png`, decode(part.mask));
    writeFileSync(`${lineDir}/${part.id}.png`, decode(part.lineart));
    return {
      id: part.id,
      parent: part.parent,
      pivot: part.pivot,
      z: part.z,
      box: part.box,
      mask: `/assets/masks/${slug}/${part.id}.png`,
      lineart: `/assets/lineart/${slug}/${part.id}.png`,
    };
  })
  .sort((a, b) => a.z - b.z);

const byId = new Set(rigParts.map((p) => p.id));
for (const p of rigParts) {
  if (p.parent && !byId.has(p.parent)) {
    throw new Error(`part "${p.id}" names unknown parent "${p.parent}"`);
  }
}
if (rigParts.filter((p) => !p.parent).length !== 1) {
  throw new Error("expected exactly one root part");
}

mkdirSync(resolve("world/rigs"), { recursive: true });
const outPath = resolve(`world/rigs/${slug}.json`);
writeFileSync(
  outPath,
  `${JSON.stringify(
    {
      slug,
      texture: CANVAS,
      // Where the printed drawing sits inside the canonical texture. The print page
      // reads this too, so the sheet and the rig cannot drift apart.
      artwork: { src: artworkSrc, ...built.placement },
      parts: rigParts,
    },
    null,
    2,
  )}\n`,
);

if (process.env.RIG_DEBUG) {
  writeFileSync(resolve(process.env.RIG_DEBUG), decode(built.debug));
  console.log(`  debug overlay -> ${process.env.RIG_DEBUG}`);
}

const missed = (built.unclaimed / built.silhouettePixels) * 100;
console.log(`${slug}: ${rigParts.length} parts -> ${outPath}`);
console.log(
  `  artwork ${Math.round(built.placement.w)}x${Math.round(built.placement.h)} ` +
    `at ${Math.round(built.placement.x)},${Math.round(built.placement.y)}`,
);
for (const p of rigParts) {
  console.log(
    `  z${p.z} ${p.id.padEnd(14)} parent=${String(p.parent).padEnd(6)} ` +
      `box=${p.box.w}x${p.box.h} @${p.box.x},${p.box.y}`,
  );
}
console.log(`  unclaimed silhouette: ${missed.toFixed(2)}%`);
if (missed > 1) {
  console.error(
    `  WARNING: ${missed.toFixed(2)}% of the drawing belongs to no part and will be ` +
      `missing on screen. Widen the polygons in assets/dino/${slug}.svg.`,
  );
}
