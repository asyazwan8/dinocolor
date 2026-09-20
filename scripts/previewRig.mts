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

    // Cut one piece per part, from the one sheet, at its rest position.
    const cutouts = rig.parts.map((part, i) => {
      const { box } = part;
      const [piece, cut] = make(box.w, box.h);
      cut.drawImage(texture, -box.x, -box.y);
      cut.globalCompositeOperation = "destination-in";
      cut.drawImage(masks[i], 0, 0);
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
