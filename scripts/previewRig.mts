/**
 * Render the rig POSED, across a full stride, with a deliberately messy fake
 * "colouring" so the deformation can be eyeballed.
 *
 *   npx vite-node scripts/previewRig.mts -- triceratops out.png
 *
 * The rest pose is the one pose that is always fine - every vertex sits exactly where
 * it was drawn - which is precisely why a rest-only preview let a rig that tears at
 * the hips pass every check. So this walks the animal.
 *
 * Each triangle is drawn as an affine warp from its rest position to its posed one,
 * which is what the GPU does with the same buffers. A tear, a fold or a runaway weight
 * therefore looks here exactly as it will on the screen.
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { poseGait } from "../world/gait";
import { Skeleton, skinMesh } from "../world/skin";
import type { Rig } from "../world/types";

const args = process.argv.slice(2).filter((a) => a !== "--");
const slug = args[0] ?? "triceratops";
const out = args[1] ?? "rig-preview.png";
/** Frames across one full stride. Enough to see the extremes and the hand-off. */
const FRAMES = 6;

const rig: Rig = JSON.parse(readFileSync(resolve(`world/rigs/${slug}.json`), "utf8"));

const skeleton = new Skeleton(rig.bones);
const root = rig.bones[skeleton.rootIndex].pivot;
const ids = rig.bones.map((b) => b.id);
const rotation = new Float32Array(rig.bones.length);
const posed = new Float32Array(rig.mesh.vertexCount * 2);

const frames: number[][] = [];
for (let f = 0; f < FRAMES; f++) {
  const clock = { phase: (f / FRAMES) * Math.PI * 2, breath: 0 };
  const bob = poseGait(ids, skeleton.rootIndex, clock, 1, rotation);
  skinMesh(rig.mesh, skeleton.solve(rotation, 0, bob), posed);
  // Back into canvas space: the skinner works relative to the root pivot.
  const abs = new Array(posed.length);
  for (let i = 0; i < posed.length; i += 2) {
    abs[i] = posed[i] + root.x;
    abs[i + 1] = posed[i + 1] + root.y;
  }
  frames.push(abs);
}

// Chromium refuses file:// subresources on a setContent page, so inline the PNGs.
const inline = (p: string) =>
  `data:image/png;base64,${readFileSync(resolve("public" + p)).toString("base64")}`;

const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
});
const page = await browser.newPage({
  viewport: { width: rig.texture.w, height: rig.texture.h * FRAMES },
});

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
    const [silhouette, shade, lineart] = await Promise.all([
      load(layers.silhouette),
      load(layers.shade),
      load(layers.lineart),
    ]);

    /**
     * Stand-in for a child's rectified sheet. Bands rather than a flat fill: a
     * deformation that folds, shears or tears shows up in how the bands run long
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

    const [sheet, ctx] = make(w, h * FRAMES);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h * FRAMES);

    const rest = rig.mesh.positions;
    const indices = rig.mesh.indices;

    frames.forEach((abs, f) => {
      ctx.save();
      ctx.translate(0, f * h);

      for (let t = 0; t < indices.length; t += 3) {
        const i0 = indices[t] * 2;
        const i1 = indices[t + 1] * 2;
        const i2 = indices[t + 2] * 2;

        const ux = [rest[i0], rest[i1], rest[i2]];
        const uy = [rest[i0 + 1], rest[i1 + 1], rest[i2 + 1]];
        let px = [abs[i0], abs[i1], abs[i2]];
        let py = [abs[i0 + 1], abs[i1 + 1], abs[i2 + 1]];

        // Grow each triangle by a hair about its centroid. Clipping is antialiased, so
        // abutting triangles otherwise leave a hairline of background between them -
        // an artefact of this renderer, not of the mesh, and one that would look
        // exactly like the tearing this preview exists to catch.
        const cx = (px[0] + px[1] + px[2]) / 3;
        const cy = (py[0] + py[1] + py[2]) / 3;
        px = px.map((v) => cx + (v - cx) * 1.02);
        py = py.map((v) => cy + (v - cy) * 1.02);

        const det =
          (ux[1] - ux[0]) * (uy[2] - uy[0]) - (ux[2] - ux[0]) * (uy[1] - uy[0]);
        if (!det) continue;

        const a = ((px[1] - px[0]) * (uy[2] - uy[0]) - (px[2] - px[0]) * (uy[1] - uy[0])) / det;
        const b = ((py[1] - py[0]) * (uy[2] - uy[0]) - (py[2] - py[0]) * (uy[1] - uy[0])) / det;
        const c = ((px[2] - px[0]) * (ux[1] - ux[0]) - (px[1] - px[0]) * (ux[2] - ux[0])) / det;
        const d = ((py[2] - py[0]) * (ux[1] - ux[0]) - (py[1] - py[0]) * (ux[2] - ux[0])) / det;

        ctx.save();
        ctx.beginPath();
        ctx.moveTo(px[0], py[0]);
        ctx.lineTo(px[1], py[1]);
        ctx.lineTo(px[2], py[2]);
        ctx.closePath();
        ctx.clip();
        ctx.transform(a, b, c, d, px[0] - a * ux[0] - c * uy[0], py[0] - b * ux[0] - d * uy[0]);
        ctx.drawImage(texture, 0, 0);
        ctx.restore();
      }

      ctx.restore();
      ctx.fillStyle = "#0003";
      ctx.fillRect(0, (f + 1) * h - 1, w, 1);
    });

    return sheet.toDataURL("image/png");
  },
  {
    rig: { texture: rig.texture, mesh: { positions: rig.mesh.positions, indices: rig.mesh.indices } },
    frames,
    layers: {
      silhouette: inline(rig.layers.silhouette),
      shade: inline(rig.layers.shade),
      lineart: inline(rig.layers.lineart),
    },
    FRAMES,
  },
);

await browser.close();

const { writeFileSync } = await import("node:fs");
writeFileSync(resolve(out), Buffer.from(png.split(",")[1], "base64"));
console.log(`${slug}: ${FRAMES} posed frames -> ${out}`);
