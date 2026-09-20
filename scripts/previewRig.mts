/**
 * Render the rig POSED, across a full stride, with a deliberately messy fake
 * "colouring" so the parts can be eyeballed.
 *
 *   npx vite-node scripts/previewRig.mts -- triceratops out.png
 *
 * The rest pose is the one pose that is always fine - every part sits exactly where it
 * was drawn - which is precisely why a rest-only preview let a rig that tears at the
 * hips pass every check. So this walks the animal.
 *
 * Each part is drawn as a rigid rotation about its own pivot, in the rig's own order,
 * back to front. That is exactly what the runtime does, so what shows up here is what
 * shows up on the screen: if a cut is visible at any point in the stride, it is
 * visible in this strip.
 */
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { poseGait } from "../world/gait";
import { Skeleton } from "../world/skeleton";
import type { Rig } from "../world/types";

const args = process.argv.slice(2).filter((a) => a !== "--");
const slug = args[0] ?? "triceratops";
const out = args[1] ?? "rig-preview.png";
/** Frames across one full stride. Enough to see the extremes and the hand-off. */
const FRAMES = 6;

const rig: Rig = JSON.parse(readFileSync(resolve(`world/rigs/${slug}.json`), "utf8"));

const skeleton = new Skeleton(rig.parts);
const root = rig.parts[skeleton.rootIndex].pivot;
const ids = rig.parts.map((p) => p.id);
const rotation = new Float32Array(rig.parts.length);

/** For each frame, every part's placement: where its pivot goes, and by how much it turns. */
const frames: { x: number; y: number; rot: number }[][] = [];
for (let f = 0; f < FRAMES; f++) {
  const clock = { phase: (f / FRAMES) * Math.PI * 2, breath: 0 };
  const bob = poseGait(ids, skeleton.rootIndex, clock, 1, rotation);
  const solved = skeleton.solve(rotation, 0, bob);
  frames.push(
    rig.parts.map((_, i) => ({
      // Back into canvas space: the skeleton works relative to the root pivot.
      x: solved.x[i] + root.x,
      y: solved.y[i] + root.y,
      rot: solved.rot[i],
    })),
  );
}

// Chromium refuses file:// subresources on a setContent page, so inline the PNGs.
const inline = (p: string) =>
  `data:image/png;base64,${readFileSync(resolve("public" + p)).toString("base64")}`;

const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
});
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });

const png = await page.evaluate(
  async ({ rig, frames, layers, FRAMES }) => {
    const load = (src: string) =>
      new Promise<HTMLImageElement>((ok, no) => {
        const img = new Image();
        img.onload = () => ok(img);
        img.onerror = () => no(new Error(src.slice(0, 40)));
        img.src = src;
      });

    const make = (w: number, h: number) => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      return [c, c.getContext("2d")!] as const;
    };

    const { w, h } = rig.texture;
    const [silhouette, shade, lineart, ...masks] = await Promise.all([
      load(layers.silhouette),
      load(layers.shade),
      load(layers.lineart),
      ...layers.masks.map(load),
    ]);

    /**
     * Stand-in for a child's rectified sheet. Bands rather than a flat fill: a part
     * that slips relative to its neighbour shows up in how the bands line up long
     * before it is visible in the outline.
     */
    const [texture, tex] = make(w, h);
    for (let i = 0; i * 60 < w + h; i++) {
      tex.fillStyle = ["#e8443a", "#f2c230", "#3aa0e8", "#59c24d"][i % 4];
      tex.save();
      tex.translate(i * 60, 0);
      tex.transform(1, 0, -0.5, 1, 0, 0);
      tex.fillRect(0, 0, 60, h);
      tex.restore();
    }
    tex.globalCompositeOperation = "destination-in";
    tex.drawImage(silhouette, 0, 0, w, h);
    tex.globalCompositeOperation = "multiply";
    tex.drawImage(shade, 0, 0, w, h);
    tex.globalCompositeOperation = "source-over";
    tex.drawImage(lineart, 0, 0, w, h);

    /**
     * The same sheet with the printed lines filled in by the nearest colour, for the
     * hidden half of every part. Kept in step with `world/composite.ts` by hand - the
     * runtime's version cannot be imported into a page evaluate - and it has to be,
     * because the whole point of this strip is that it renders what the screen renders.
     */
    const pixels = tex.getImageData(0, 0, w, h);
    const lines = (() => {
      const [, c] = make(w, h);
      c.drawImage(lineart, 0, 0, w, h);
      return c.getImageData(0, 0, w, h).data;
    })();

    // Same three numbers as world/composite.ts: what counts as ink, how far the ink
    // mask is grown to swallow the photograph's own registration slop, and what counts
    // as part of the drawing rather than bare paper.
    const INK_ALPHA = 20;
    const INK_GROW = 3;
    const OPAQUE = 200;

    let ink = new Uint8Array(w * h);
    for (let i = 0; i < ink.length; i++) ink[i] = lines[i * 4 + 3] > INK_ALPHA ? 1 : 0;
    for (let pass = 0; pass < INK_GROW; pass++) {
      const grown = ink.slice();
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          if (ink[i] || ink[i - 1] || ink[i + 1] || ink[i - w] || ink[i + w]) grown[i] = 1;
        }
      }
      ink = grown;
    }

    const clean = new Uint8ClampedArray(pixels.data);
    const done = new Uint8Array(w * h);
    const queue = new Int32Array(w * h);
    let tail = 0;
    for (let i = 0; i < done.length; i++) {
      if (pixels.data[i * 4 + 3] < OPAQUE || ink[i]) continue;
      done[i] = 1;
      queue[tail++] = i;
    }
    for (let head = 0; head < tail; head++) {
      const i = queue[head];
      const x = i % w;
      for (const n of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
        if (n < 0 || n >= done.length || done[n]) continue;
        if (pixels.data[n * 4 + 3] < OPAQUE) continue;
        clean[n * 4] = clean[i * 4];
        clean[n * 4 + 1] = clean[i * 4 + 1];
        clean[n * 4 + 2] = clean[i * 4 + 2];
        clean[n * 4 + 3] = 255;
        done[n] = 1;
        queue[tail++] = n;
      }
    }

    // Cut one piece per part, at its rest position: the sheet as printed where the
    // mask's red channel says the pixel is seen, the filled-in sheet where it does not.
    const cutouts = rig.parts.map((part, index) => {
      const { box } = part;
      const [piece, cut] = make(box.w, box.h);

      const [, maskCtx] = make(box.w, box.h);
      maskCtx.drawImage(masks[index], 0, 0);
      const mask = maskCtx.getImageData(0, 0, box.w, box.h).data;

      const out = cut.createImageData(box.w, box.h);
      for (let y = 0; y < box.h; y++) {
        for (let x = 0; x < box.w; x++) {
          const o = (y * box.w + x) * 4;
          if (mask[o + 3] < 128) continue;
          const from = mask[o] > 128 ? pixels.data : clean;
          const i = ((y + box.y) * w + (x + box.x)) * 4;
          out.data[o] = from[i];
          out.data[o + 1] = from[i + 1];
          out.data[o + 2] = from[i + 2];
          out.data[o + 3] = 255;
        }
      }
      cut.putImageData(out, 0, 0);
      return piece;
    });

    const [sheet, ctx] = make(w, h * FRAMES);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h * FRAMES);

    frames.forEach((placements, f) => {
      ctx.save();
      ctx.translate(0, f * h);

      // Back to front, exactly as the runtime stacks them.
      rig.parts.forEach((part, index) => {
        const at = placements[index];
        ctx.save();
        ctx.translate(at.x, at.y);
        ctx.rotate(at.rot);
        ctx.translate(-part.pivot.x, -part.pivot.y);

        // Each part is its own cut-out, drawn at the box it was cut from - exactly
        // what the runtime does with a sprite per part.
        ctx.drawImage(cutouts[index], part.box.x, part.box.y);
        ctx.restore();
      });

      ctx.restore();
      ctx.fillStyle = "#0003";
      ctx.fillRect(0, (f + 1) * h - 1, w, 1);
    });

    return sheet.toDataURL("image/png");
  },
  {
    rig: {
      texture: rig.texture,
      parts: rig.parts.map((p) => ({ pivot: p.pivot, box: p.box })),
    },
    frames,
    layers: {
      silhouette: inline(rig.layers.silhouette),
      shade: inline(rig.layers.shade),
      lineart: inline(rig.layers.lineart),
      masks: rig.parts.map((p) => inline(p.mask)),
    },
    FRAMES,
  },
);

await browser.close();

writeFileSync(resolve(out), Buffer.from(png.split(",")[1], "base64"));
console.log(`${slug}: ${FRAMES} posed frames -> ${out}`);
