/**
 * Turn printed artwork plus a skeleton into a set of rigid parts.
 *
 *   assets/dino/<slug>.svg          seed points, pivots, draw order, the belly cut
 *   public/assets/dino/<slug>.png   the printed drawing
 *     -> world/rigs/<slug>.json          one cut-out per part
 *     -> public/assets/dino/<slug>/parts/ one alpha mask per part
 *     -> public/assets/dino/<slug>/      silhouette, lineart and shade, whole
 *
 * The drawing is cut into pieces that each move RIGIDLY, and every cut is put where
 * the body itself covers it. That is the whole idea, and it is the fifth attempt at
 * this: bending the drawing with blend skinning cannot be seamless, because a joint
 * must have a weight gradient somewhere and the two bones differ most exactly there,
 * so whatever ink crosses it is sheared. Rigid parts have no gradient to shear.
 *
 * Two rules make the cuts invisible, and they are the difference between this and the
 * cutout rig that looked chopped up:
 *
 *   1. Every part boundary that can be SEEN lies on a line the artist drew. The parts
 *      are not outlined here - each one floods out from a seed through the drawing's
 *      interior until the printed ink stops it.
 *   2. Every moving part is drawn BEHIND the body, so the cut across its top is
 *      painted over at any angle. Each limb then carries on past that cut, into the
 *      torso, so no swing can open a gap at the hip - but only inside a disc about its
 *      own joint, which is what keeps that hidden material from swinging out into
 *      open paper somewhere along the belly.
 *
 * The silhouette is derived from the artwork rather than traced. Flooding inward from
 * the border marks everything the flood can reach as paper; what it cannot reach is
 * the dinosaur, ink and enclosed white alike.
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
/** Anything at least this bright counts as paper for the silhouette flood. */
const PAPER_LEVEL = 232;
/** Above this luminance the drawing is paper, and drops out of the ink layer. */
const INK_FLOOR = 238;

/**
 * Darker than this is a drawn line, and a drawn line is a wall.
 *
 * Deliberately not the same as INK_FLOOR. That one decides what is dark enough to
 * SHOW; this one decides what is dark enough to STOP a flood, and it wants to be well
 * clear of the antialiasing along an edge so that a part cannot leak through a line
 * into its neighbour.
 */
const INK_WALL = 170;

/**
 * Form shading. Restrained on purpose: the drawing's own outline carries the shape,
 * and depth on screen comes from lane scale and haze. Heavy shading here only
 * succeeds in dirtying the paper a child left white.
 */
const SHADE_STRENGTH = 0.3;
const SHADE_BLUR = 22;
/** Light from the upper left, so the band survives along the lower right. */
const SHADE_OFFSET = { x: 14, y: 18 };

/**
 * How far below the traced belly the cut actually runs.
 *
 * The trace follows the drawn line; the cut has to fall just under it so the ink ends
 * up on the BODY's side. A belly line that swung with a leg is exactly the artefact
 * this rig exists to remove.
 */
const CUT_BELOW = 9;
/** How thick the cut is painted. Thick enough that no flood squeezes through it. */
const CUT_WIDTH = 7;

/**
 * The disc a limb's bury is confined to, as a multiple of how far the limb reaches to
 * either side of its own joint. A little over 1 is what keeps the hip closed at the
 * ends of the swing without the buried part starting to overhang the limb.
 */
const HIP_MARGIN = 1.6;
/**
 * How far a part that does not swing reaches under whatever covers it. Only has to
 * survive the few degrees a head turns, not a full stride.
 */
const OVERLAP = 26;

const svg = readFileSync(resolve(`assets/dino/${slug}.svg`), "utf8");
const artworkSrc = /data-artwork="([^"]+)"/.exec(svg)?.[1];
if (!artworkSrc) throw new Error(`${slug}.svg has no data-artwork attribute`);

const artworkDataUrl = `data:image/png;base64,${readFileSync(
  resolve(`public${artworkSrc}`),
).toString("base64")}`;

const browser = await chromium.launch({ executablePath: CHROMIUM });
const page = await browser.newPage({ viewport: { width: CANVAS.w, height: CANVAS.h } });
await page.setContent(`<style>html,body{margin:0}</style>${svg}`, { waitUntil: "load" });

const parts = await page.evaluate(() =>
  [...document.querySelectorAll("#parts > circle")]
    .map((el) => {
      const [px, py] = el.dataset.pivot.split(",").map(Number);
      return {
        id: el.id.replace(/^part-/, ""),
        parent: el.dataset.parent || null,
        pivot: { x: px, y: py },
        z: Number(el.dataset.z),
        seed: { x: Number(el.getAttribute("cx")), y: Number(el.getAttribute("cy")) },
      };
    })
    .sort((a, b) => a.z - b.z),
);

const cut = await page.evaluate(() => {
  const el = document.querySelector("#cut-belly");
  if (!el) return [];
  return el
    .getAttribute("points")
    .trim()
    .split(/\s+/)
    .map((pair) => pair.split(",").map(Number));
});

const built = await page.evaluate(
  async (input) => {
    const { parts, cut, artworkDataUrl, CANVAS } = input;
    const { PAPER_LEVEL, INK_FLOOR, INK_WALL } = input;
    const { SHADE_STRENGTH, SHADE_BLUR, SHADE_OFFSET } = input;
    const { CUT_BELOW, CUT_WIDTH, OVERLAP, HIP_MARGIN } = input;

    const make = (w, h) => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      return [c, c.getContext("2d", { willReadFrequently: true })];
    };

    const art = new Image();
    art.src = artworkDataUrl;
    await art.decode();

    const scale = Math.min(CANVAS.w / art.naturalWidth, CANVAS.h / art.naturalHeight);
    const placement = {
      w: art.naturalWidth * scale,
      h: art.naturalHeight * scale,
      x: (CANVAS.w - art.naturalWidth * scale) / 2,
      y: (CANVAS.h - art.naturalHeight * scale) / 2,
    };

    const [artCanvas, artCtx] = make(CANVAS.w, CANVAS.h);
    artCtx.fillStyle = "#fff";
    artCtx.fillRect(0, 0, CANVAS.w, CANVAS.h);
    artCtx.drawImage(art, placement.x, placement.y, placement.w, placement.h);
    const pixels = artCtx.getImageData(0, 0, CANVAS.w, CANVAS.h).data;
    const lumAt = (i) => (pixels[i * 4] + pixels[i * 4 + 1] + pixels[i * 4 + 2]) / 3;

    // --- silhouette -------------------------------------------------------------
    const outside = new Uint8Array(CANVAS.w * CANVAS.h);
    const stack = [];
    for (let x = 0; x < CANVAS.w; x++) stack.push(x, (CANVAS.h - 1) * CANVAS.w + x);
    for (let y = 0; y < CANVAS.h; y++) stack.push(y * CANVAS.w, y * CANVAS.w + CANVAS.w - 1);
    while (stack.length) {
      const i = stack.pop();
      if (outside[i] || lumAt(i) < PAPER_LEVEL) continue;
      outside[i] = 1;
      const x = i % CANVAS.w;
      if (x > 0) stack.push(i - 1);
      if (x < CANVAS.w - 1) stack.push(i + 1);
      if (i >= CANVAS.w) stack.push(i - CANVAS.w);
      if (i < CANVAS.w * (CANVAS.h - 1)) stack.push(i + CANVAS.w);
    }

    const [silCanvas, silCtx] = make(CANVAS.w, CANVAS.h);
    const sil = silCtx.createImageData(CANVAS.w, CANVAS.h);
    for (let i = 0; i < outside.length; i++) if (!outside[i]) sil.data[i * 4 + 3] = 255;
    silCtx.putImageData(sil, 0, 0);

    // --- ink and shade ----------------------------------------------------------
    const [lineCanvas, lineCtx] = make(CANVAS.w, CANVAS.h);
    lineCtx.drawImage(artCanvas, 0, 0);
    const line = lineCtx.getImageData(0, 0, CANVAS.w, CANVAS.h);
    for (let i = 0; i < line.data.length; i += 4) {
      const lum = (line.data[i] + line.data[i + 1] + line.data[i + 2]) / 3;
      line.data[i] = 17;
      line.data[i + 1] = 17;
      line.data[i + 2] = 17;
      line.data[i + 3] =
        lum >= INK_FLOOR ? 0 : Math.round(((INK_FLOOR - lum) / INK_FLOOR) * 255);
    }
    lineCtx.putImageData(line, 0, 0);

    const [shadeCanvas, shadeCtx] = make(CANVAS.w, CANVAS.h);
    shadeCtx.fillStyle = `rgba(72, 62, 48, ${SHADE_STRENGTH})`;
    shadeCtx.fillRect(0, 0, CANVAS.w, CANVAS.h);
    shadeCtx.globalCompositeOperation = "destination-out";
    shadeCtx.filter = `blur(${SHADE_BLUR}px)`;
    shadeCtx.drawImage(silCanvas, -SHADE_OFFSET.x, -SHADE_OFFSET.y);
    shadeCtx.filter = "none";
    shadeCtx.globalCompositeOperation = "destination-in";
    shadeCtx.drawImage(silCanvas, 0, 0);

    // --- walls ------------------------------------------------------------------
    /**
     * What a flood may not cross: the printed lines, the paper outside the drawing,
     * and the one cut the drawing does not provide.
     */
    const [wallCanvas, wallCtx] = make(CANVAS.w, CANVAS.h);
    wallCtx.strokeStyle = "#000";
    wallCtx.lineWidth = CUT_WIDTH;
    wallCtx.lineCap = "round";
    wallCtx.lineJoin = "round";
    wallCtx.beginPath();
    cut.forEach(([x, y], i) => {
      if (i === 0) wallCtx.moveTo(x, y + CUT_BELOW);
      else wallCtx.lineTo(x, y + CUT_BELOW);
    });
    wallCtx.stroke();
    const cutPixels = wallCtx.getImageData(0, 0, CANVAS.w, CANVAS.h).data;

    const wall = new Uint8Array(CANVAS.w * CANVAS.h);
    for (let i = 0; i < wall.length; i++) {
      wall[i] = outside[i] || lumAt(i) < INK_WALL || cutPixels[i * 4 + 3] > 40 ? 1 : 0;
    }

    // --- one region per part ----------------------------------------------------
    /**
     * Flood outward from each seed through the drawing's interior. The printed lines
     * stop it, so the region a part ends up with is bounded by the artist's own
     * strokes - a leg by its own outline, the head by the frill's. Nothing here has
     * to guess where a part ends.
     */
    const owner = new Int16Array(CANVAS.w * CANVAS.h).fill(-1);
    parts.forEach((part, index) => {
      const start = Math.round(part.seed.y) * CANVAS.w + Math.round(part.seed.x);
      if (wall[start]) {
        throw new Error(`seed for "${part.id}" landed on a line or outside the drawing`);
      }
      const queue = [start];
      owner[start] = index;
      while (queue.length) {
        const i = queue.pop();
        const x = i % CANVAS.w;
        for (const n of [
          x > 0 ? i - 1 : -1,
          x < CANVAS.w - 1 ? i + 1 : -1,
          i - CANVAS.w,
          i + CANVAS.w,
        ]) {
          if (n < 0 || n >= owner.length) continue;
          if (owner[n] !== -1 || wall[n]) continue;
          owner[n] = index;
          queue.push(n);
        }
      }
    });

    /**
     * Then hand out the lines themselves, growing every region at the same rate so
     * each stroke goes to whichever part it borders - and when two parts share one
     * stroke, to the one drawn in front, since its pixels are the ones you see.
     */
    let frontier = [];
    for (let i = 0; i < owner.length; i++) if (owner[i] !== -1) frontier.push(i);
    while (frontier.length) {
      const next = [];
      for (const i of frontier) {
        const x = i % CANVAS.w;
        for (const n of [
          x > 0 ? i - 1 : -1,
          x < CANVAS.w - 1 ? i + 1 : -1,
          i - CANVAS.w,
          i + CANVAS.w,
        ]) {
          if (n < 0 || n >= owner.length || outside[n]) continue;
          if (owner[n] === -1) {
            owner[n] = owner[i];
            next.push(n);
          } else if (owner[n] !== owner[i] && parts[owner[i]].z > parts[owner[n]].z) {
            // a shared stroke: the nearer part keeps it
            owner[n] = owner[i];
          }
        }
      }
      frontier = next;
    }

    // --- bury each part under the ones drawn in front of it ---------------------
    /**
     * A part's region stops where it stops being visible, which is not where it needs
     * to stop existing. Grow each one under whatever is drawn over it, so there is
     * always something behind the covering part however far either of them turns, and
     * no sliver of paper can show through the join.
     *
     * For a limb the growth is confined to a DISC ABOUT ITS PIVOT, and that is the
     * whole trick. A limb rotates, so its buried part rotates too, and a plain
     * dilation spreads sideways along the belly - which slopes up towards the tail and
     * the chest, so a quarter of a radian later the far end of that strip is hanging
     * in mid air. A disc centred on the joint cannot do that: rotation maps it onto
     * itself, so whatever emerges from under the belly emerges next to the limb, as
     * the limb, which is exactly the material needed to keep the hip closed.
     *
     * Its radius is the limb's own half-width at the hip, with a margin. Wider buys
     * nothing and starts to overhang; narrower leaves a notch at the top of the swing.
     *
     * The body only has to reach a little way under the head, which barely turns, so
     * it gets a plain fixed overlap.
     */
    const regions = parts.map(() => new Uint8Array(CANVAS.w * CANVAS.h));
    for (let i = 0; i < owner.length; i++) if (owner[i] !== -1) regions[owner[i]][i] = 1;

    const inFront = new Uint8Array(parts.length * parts.length);
    parts.forEach((a, i) =>
      parts.forEach((b, j) => {
        inFront[i * parts.length + j] = b.z > a.z ? 1 : 0;
      }),
    );

    /** How far a limb reaches to either side of its joint. */
    const hipRadius = (region, pivot) => {
      let reach = 0;
      for (let i = 0; i < region.length; i++) {
        if (region[i]) reach = Math.max(reach, Math.abs((i % CANVAS.w) - pivot.x));
      }
      return reach * HIP_MARGIN;
    };

    const radii = [];
    parts.forEach((part, index) => {
      const limb = part.id.startsWith("leg");
      // A limb's growth is bounded by its disc, so it needs no step limit of its own.
      const depth = limb ? Infinity : OVERLAP;
      const radius = limb ? hipRadius(regions[index], part.pivot) : Infinity;
      if (limb) radii.push(`${part.id} r=${Math.round(radius)}`);
      const radiusSq = radius * radius;

      const grown = regions[index].slice();
      let ring = [];
      for (let i = 0; i < owner.length; i++) if (regions[index][i]) ring.push(i);
      for (let step = 0; step < depth && ring.length; step++) {
        const next = [];
        for (const i of ring) {
          const x = i % CANVAS.w;
          for (const n of [
            x > 0 ? i - 1 : -1,
            x < CANVAS.w - 1 ? i + 1 : -1,
            i - CANVAS.w,
            i + CANVAS.w,
          ]) {
            if (n < 0 || n >= grown.length || grown[n]) continue;
            // Never out onto paper: there is no ink there to grow into.
            if (owner[n] === -1) continue;
            // A limb may grow into ANY neighbouring part inside its disc, in front or
            // behind. Every part samples the same sheet at the same place, so at rest
            // two overlapping masks paint identical pixels and the overlap cannot be
            // seen; it only starts to matter once they move apart, which is precisely
            // when it is needed. Growing under the body keeps the hip closed; growing
            // over the leg behind stops a notch opening where the two were drawn
            // touching. The body is different - it is drawn last, so anything it grew
            // over it would hide - and keeps the in-front rule.
            if (!limb && !inFront[index * parts.length + owner[n]]) continue;
            const dx = (n % CANVAS.w) - part.pivot.x;
            const dy = ((n / CANVAS.w) | 0) - part.pivot.y;
            if (dx * dx + dy * dy > radiusSq) continue;
            grown[n] = 1;
            next.push(n);
          }
        }
        ring = next;
      }
      regions[index] = grown;
    });

    // --- which of each part can actually be seen --------------------------------
    /**
     * A part's region is not all visible: the parts are painted in order, so anything a
     * LATER part also covers is hidden at rest. That is most of a limb - the whole of
     * what was buried under the belly - and it is the half that has to be coloured
     * without the printed lines, because it is the half that swings out into view.
     *
     * Note this is about being painted over, not about how the pixel was acquired. A
     * limb also grows sideways over the limb BEHIND it, to stop a notch opening where
     * the two were drawn touching, and that material is on top rather than underneath.
     * It keeps the sheet exactly as printed: erasing the lines there would rub out the
     * outline of the leg behind while the two are still overlapping.
     */
    const hidden = parts.map(() => new Uint8Array(CANVAS.w * CANVAS.h));
    parts.forEach((_, index) => {
      for (let over = index + 1; over < parts.length; over++) {
        for (let i = 0; i < hidden[index].length; i++) {
          if (regions[over][i]) hidden[index][i] = 1;
        }
      }
    });

    // --- a masked cut-out per region --------------------------------------------
    /**
     * Each part ships as a rectangle of the sheet plus an alpha mask, rather than as a
     * mesh shaped like the part.
     *
     * The parts are RIGID, so a mesh buys nothing but the accuracy of its own outline,
     * and a grid's staircase is plainly visible wherever one part meets another. The
     * mask is exact to the pixel, follows the flood - and therefore the artist's lines
     * - and leaves the runtime with nothing to draw but a sprite.
     */
    const cutouts = parts.map((part, index) => {
      const region = regions[index];
      let minX = CANVAS.w;
      let minY = CANVAS.h;
      let maxX = -1;
      let maxY = -1;
      let area = 0;
      for (let i = 0; i < region.length; i++) {
        if (!region[i]) continue;
        area++;
        const x = i % CANVAS.w;
        const y = (i / CANVAS.w) | 0;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      if (area === 0) throw new Error(`part "${part.id}" claimed nothing`);

      const box = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
      const [maskCanvas, maskCtx] = make(box.w, box.h);
      const mask = maskCtx.createImageData(box.w, box.h);
      for (let y = 0; y < box.h; y++) {
        for (let x = 0; x < box.w; x++) {
          const i = (y + box.y) * CANVAS.w + (x + box.x);
          if (!region[i]) continue;
          const o = (y * box.w + x) * 4;
          // Alpha says whether the pixel belongs to this part; red says whether it is
          // ever seen. The level goes in a colour channel rather than in alpha because
          // a canvas premultiplies, so an intermediate alpha does not survive the round
          // trip through a PNG, and a colour channel of an opaque pixel does. It also
          // leaves anything that reads only alpha working unchanged.
          mask.data[o] = hidden[index][i] ? 0 : 255;
          mask.data[o + 1] = 255;
          mask.data[o + 2] = 255;
          mask.data[o + 3] = 255;
        }
      }
      maskCtx.putImageData(mask, 0, 0);

      return { box, area, mask: maskCanvas.toDataURL("image/png") };
    });

    // --- did anything fall through? ---------------------------------------------
    let silhouettePixels = 0;
    let unclaimed = 0;
    for (let i = 0; i < outside.length; i++) {
      if (outside[i]) continue;
      silhouettePixels++;
      if (owner[i] === -1) unclaimed++;
    }

    // --- debug view -------------------------------------------------------------
    const [dbg, dbgCtx] = make(CANVAS.w, CANVAS.h);
    dbgCtx.globalAlpha = 0.2;
    dbgCtx.drawImage(artCanvas, 0, 0);
    dbgCtx.globalAlpha = 1;
    const hues = ["#e0453a", "#e88a1e", "#c9b826", "#3fa64d", "#2f8fd0", "#7a54c8", "#d052a0"];
    const paint = dbgCtx.createImageData(CANVAS.w, CANVAS.h);
    const rgb = (hex) => [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16));
    for (let i = 0; i < owner.length; i++) {
      if (owner[i] === -1) continue;
      const [r, g, b] = rgb(hues[owner[i] % hues.length]);
      paint.data[i * 4] = r;
      paint.data[i * 4 + 1] = g;
      paint.data[i * 4 + 2] = b;
      paint.data[i * 4 + 3] = 130;
    }
    // the buried part of each limb, brighter, so the hidden overlap is visible
    parts.forEach((part, index) => {
      if (!part.id.startsWith("leg")) return;
      const [r, g, b] = rgb(hues[index % hues.length]);
      for (let i = 0; i < owner.length; i++) {
        if (!regions[index][i] || owner[i] === index) continue;
        paint.data[i * 4] = r;
        paint.data[i * 4 + 1] = g;
        paint.data[i * 4 + 2] = b;
        paint.data[i * 4 + 3] = 235;
      }
    });
    const [tint, tintCtx] = make(CANVAS.w, CANVAS.h);
    tintCtx.putImageData(paint, 0, 0);
    dbgCtx.drawImage(tint, 0, 0);
    for (const part of parts) {
      dbgCtx.fillStyle = "#000";
      dbgCtx.beginPath();
      dbgCtx.arc(part.pivot.x, part.pivot.y, 7, 0, Math.PI * 2);
      dbgCtx.fill();
    }

    return {
      placement,
      silhouette: silCanvas.toDataURL("image/png"),
      lineart: lineCanvas.toDataURL("image/png"),
      shade: shadeCanvas.toDataURL("image/png"),
      cutouts,
      radii,
      silhouettePixels,
      unclaimed,
      debug: dbg.toDataURL("image/png"),
    };
  },
  {
    parts,
    cut,
    artworkDataUrl,
    CANVAS,
    PAPER_LEVEL,
    INK_FLOOR,
    INK_WALL,
    SHADE_STRENGTH,
    SHADE_BLUR,
    SHADE_OFFSET,
    CUT_BELOW,
    CUT_WIDTH,
    OVERLAP,
    HIP_MARGIN,
  },
);

await browser.close();

const layerDir = resolve(`public/assets/dino/${slug}`);
rmSync(layerDir, { recursive: true, force: true });
mkdirSync(layerDir, { recursive: true });

const decode = (dataUrl) => Buffer.from(dataUrl.split(",")[1], "base64");
for (const name of ["silhouette", "lineart", "shade"]) {
  writeFileSync(`${layerDir}/${name}.png`, decode(built[name]));
}

// One alpha mask per part. Shared by every dinosaur of the species, like the layers.
mkdirSync(`${layerDir}/parts`, { recursive: true });
parts.forEach((part, index) => {
  writeFileSync(`${layerDir}/parts/${part.id}.png`, decode(built.cutouts[index].mask));
});

if (process.env.RIG_DEBUG) {
  writeFileSync(resolve(process.env.RIG_DEBUG), decode(built.debug));
  console.log(`  debug overlay -> ${process.env.RIG_DEBUG}`);
}

const byId = new Set(parts.map((p) => p.id));
for (const part of parts) {
  if (part.parent && !byId.has(part.parent)) {
    throw new Error(`part "${part.id}" names unknown parent "${part.parent}"`);
  }
}

const root = parts.find((p) => !p.parent);
if (!root) throw new Error(`${slug} has no root part`);

/**
 * How far the drawing reaches from the ROOT PIVOT, which is where the world positions
 * a dinosaur from. The pivot sits inside the body, nowhere near the middle of the
 * artwork - a Triceratops reaches much further forward, into its frill and horns, than
 * it does back into its tail - so callers that need to know when the animal is off
 * screen have to use these, not half the artwork's width.
 */
let footDrop = -Infinity;
let left = Infinity;
let right = -Infinity;
for (const { box } of built.cutouts) {
  footDrop = Math.max(footDrop, box.y + box.h - root.pivot.y);
  left = Math.min(left, box.x - root.pivot.x);
  right = Math.max(right, box.x + box.w - root.pivot.x);
}

const outPath = resolve(`world/rigs/${slug}.json`);
writeFileSync(
  outPath,
  `${JSON.stringify(
    {
      slug,
      texture: CANVAS,
      artwork: { src: artworkSrc, ...built.placement },
      layers: {
        silhouette: `/assets/dino/${slug}/silhouette.png`,
        lineart: `/assets/dino/${slug}/lineart.png`,
        shade: `/assets/dino/${slug}/shade.png`,
      },
      footDrop,
      extent: { left, right },
      // in draw order, back to front
      parts: parts.map((part, index) => ({
        id: part.id,
        parent: part.parent,
        pivot: part.pivot,
        z: part.z,
        box: built.cutouts[index].box,
        mask: `/assets/dino/${slug}/parts/${part.id}.png`,
      })),
    },
    null,
    1,
  )}\n`,
);

console.log(`${slug}: ${parts.length} parts -> ${outPath}`);
console.log(
  `  artwork ${Math.round(built.placement.w)}x${Math.round(built.placement.h)} at ` +
    `${Math.round(built.placement.x)},${Math.round(built.placement.y)}`,
);
parts.forEach((part, index) => {
  const { box, area } = built.cutouts[index];
  console.log(
    `  z${part.z} ${part.id.padEnd(13)} ${String(box.w).padStart(4)}x${String(box.h).padEnd(4)}` +
      ` at ${String(box.x).padStart(4)},${String(box.y).padStart(3)}` +
      `  ${String(Math.round(area / 1000)).padStart(3)}k px`,
  );
});

console.log(`  hip discs  ${built.radii.join("  ")}`);
const missed = (built.unclaimed / built.silhouettePixels) * 100;
console.log(`  unclaimed ${missed.toFixed(2)}% of the drawing`);
if (missed > 0.5) {
  console.error(
    `\n  ${slug}: ${missed.toFixed(1)}% of the drawing belongs to no part.\n` +
      `  A seed is probably walled off from part of its own region.\n` +
      `  RIG_DEBUG=out.png shows what each part claimed.`,
  );
  process.exit(1);
}
