/**
 * Turn printed artwork plus a skeleton into a skinned mesh.
 *
 *   assets/dino/<slug>.svg          bone polygons + a reference to the artwork
 *   public/assets/dino/<slug>.png   the printed drawing
 *     -> world/rigs/<slug>.json          bones, mesh, weights
 *     -> public/assets/dino/<slug>/      silhouette, lineart and shade, whole
 *
 * The drawing is never cut up. A grid of vertices covers it, each vertex is bound to
 * a few bones, and bending the bones bends the whole drawing at once. That is what
 * makes seams impossible: there are no parts to come apart.
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
/** Anything at least this bright counts as paper for the flood. */
const PAPER_LEVEL = 232;
/** Above this luminance the drawing is paper, and drops out of the ink layer. */
const INK_FLOOR = 238;

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
 * Mesh density. Fine enough to bend smoothly at a hip, coarse enough that ten
 * dinosaurs of these can be skinned every frame.
 */
const GRID_STEP = 24;
/** Bones allowed to influence one vertex. Three is plenty for limbs off one torso. */
const MAX_INFLUENCES = 3;
/**
 * Weight relaxation. Ownership from the polygons is a hard partition; averaging it
 * across neighbours turns every hand-off into a gradient, and spread grows roughly as
 * the square root of the pass count.
 *
 * The count is set by the worst joint in the drawing, not by the gentlest. The two
 * front feet TOUCH on the sheet, heel to toe, and in a diagonal gait they swing in
 * opposite directions - so the handful of triangles bridging them have to absorb the
 * full relative swing of two limbs. Measured across a stride at full swing: 18 passes
 * turns those triangles inside out, which renders as black shards flickering between
 * the feet; 48 clears it with the mesh's worst triangle merely creasing. Past about
 * 70 it gets worse again from the other side, as the blend grows wide enough to bind
 * regions that have no business moving together.
 */
const RELAX_PASSES = 48;
const RELAX_RATE = 0.5;

const svg = readFileSync(resolve(`assets/dino/${slug}.svg`), "utf8");
const artworkSrc = /data-artwork="([^"]+)"/.exec(svg)?.[1];
if (!artworkSrc) throw new Error(`${slug}.svg has no data-artwork attribute`);

const artworkDataUrl = `data:image/png;base64,${readFileSync(
  resolve(`public${artworkSrc}`),
).toString("base64")}`;

const browser = await chromium.launch({ executablePath: CHROMIUM });
const page = await browser.newPage({ viewport: { width: CANVAS.w, height: CANVAS.h } });
await page.setContent(`<style>html,body{margin:0}</style>${svg}`, { waitUntil: "load" });

const bones = await page.evaluate(() =>
  [...document.querySelectorAll("#parts > polygon")]
    .map((el) => {
      const [px, py] = el.dataset.pivot.split(",").map(Number);
      return {
        id: el.id.replace(/^part-/, ""),
        parent: el.dataset.parent || null,
        pivot: { x: px, y: py },
        z: Number(el.dataset.z),
        points: el.getAttribute("points"),
      };
    })
    .sort((a, b) => a.z - b.z),
);

const built = await page.evaluate(
  async (input) => {
    const { bones, artworkDataUrl, CANVAS, PAPER_LEVEL, INK_FLOOR } = input;
    const { SHADE_STRENGTH, SHADE_BLUR, SHADE_OFFSET } = input;
    const { GRID_STEP, MAX_INFLUENCES, RELAX_PASSES, RELAX_RATE } = input;

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

    // --- silhouette -------------------------------------------------------------
    const outside = new Uint8Array(CANVAS.w * CANVAS.h);
    const stack = [];
    const isPaper = (i) => {
      const o = i * 4;
      return (pixels[o] + pixels[o + 1] + pixels[o + 2]) / 3 >= PAPER_LEVEL;
    };
    for (let x = 0; x < CANVAS.w; x++) stack.push(x, (CANVAS.h - 1) * CANVAS.w + x);
    for (let y = 0; y < CANVAS.h; y++) stack.push(y * CANVAS.w, y * CANVAS.w + CANVAS.w - 1);
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
    let minX = CANVAS.w;
    let minY = CANVAS.h;
    let maxX = -1;
    let maxY = -1;
    for (let i = 0; i < outside.length; i++) {
      if (outside[i]) continue;
      sil.data[i * 4 + 3] = 255;
      const x = i % CANVAS.w;
      const y = (i / CANVAS.w) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    silCtx.putImageData(sil, 0, 0);
    const inside = (x, y) =>
      x >= 0 && y >= 0 && x < CANVAS.w && y < CANVAS.h && !outside[y * CANVAS.w + x];

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

    // --- bone ownership map -----------------------------------------------------
    // Each polygon painted in ascending z, encoding its bone index in the red
    // channel. Reading a pixel then gives the owner directly, with the highest z
    // naturally winning any overlap because it was painted last.
    const [ownCanvas, ownCtx] = make(CANVAS.w, CANVAS.h);
    bones.forEach((bone, index) => {
      ownCtx.fillStyle = `rgb(${index + 1},0,0)`;
      ownCtx.beginPath();
      bone.points
        .trim()
        .split(/\s+/)
        .forEach((pair, i) => {
          const [px, py] = pair.split(",").map(Number);
          if (i === 0) ownCtx.moveTo(px, py);
          else ownCtx.lineTo(px, py);
        });
      ownCtx.closePath();
      ownCtx.fill();
    });
    const owners = ownCtx.getImageData(0, 0, CANVAS.w, CANVAS.h).data;

    // --- grid -------------------------------------------------------------------
    const originX = Math.max(0, minX - GRID_STEP);
    const originY = Math.max(0, minY - GRID_STEP);
    const cols = Math.ceil((Math.min(CANVAS.w, maxX + GRID_STEP) - originX) / GRID_STEP) + 1;
    const rows = Math.ceil((Math.min(CANVAS.h, maxY + GRID_STEP) - originY) / GRID_STEP) + 1;

    const gridX = (c) => originX + c * GRID_STEP;
    const gridY = (r) => originY + r * GRID_STEP;

    // Keep a cell if any corner is inside, so the boundary is always covered.
    const keep = new Uint8Array(cols * rows);
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const corners = [
          [c, r],
          [c + 1, r],
          [c, r + 1],
          [c + 1, r + 1],
        ];
        if (!corners.some(([cc, rr]) => inside(gridX(cc), gridY(rr)))) continue;
        for (const [cc, rr] of corners) keep[rr * cols + cc] = 1;
      }
    }

    const vertexOf = new Int32Array(cols * rows).fill(-1);
    const positions = [];
    const gridCoord = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (!keep[r * cols + c]) continue;
        vertexOf[r * cols + c] = positions.length / 2;
        positions.push(gridX(c), gridY(r));
        gridCoord.push(c, r);
      }
    }
    const vertexCount = positions.length / 2;

    const indices = [];
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const a = vertexOf[r * cols + c];
        const b = vertexOf[r * cols + c + 1];
        const d = vertexOf[(r + 1) * cols + c];
        const e = vertexOf[(r + 1) * cols + c + 1];
        if (a < 0 || b < 0 || d < 0 || e < 0) continue;
        indices.push(a, b, d, b, e, d);
      }
    }

    // --- weights ----------------------------------------------------------------
    const boneCount = bones.length;
    let weights = new Float32Array(vertexCount * boneCount);

    for (let v = 0; v < vertexCount; v++) {
      const x = Math.round(positions[v * 2]);
      const y = Math.round(positions[v * 2 + 1]);
      let owner = -1;
      if (x >= 0 && y >= 0 && x < CANVAS.w && y < CANVAS.h) {
        owner = owners[(y * CANVAS.w + x) * 4] - 1;
      }
      if (owner < 0) {
        // Outside every polygon: hand it to the nearest pivot, so stray vertices
        // around the silhouette edge still move with something sensible.
        let best = 0;
        let bestDistance = Infinity;
        bones.forEach((bone, i) => {
          const d = (bone.pivot.x - x) ** 2 + (bone.pivot.y - y) ** 2;
          if (d < bestDistance) {
            bestDistance = d;
            best = i;
          }
        });
        owner = best;
      }
      weights[v * boneCount + owner] = 1;
    }

    // Relax: replace each vertex's weights with a blend of its grid neighbours'.
    const neighbours = [];
    for (let v = 0; v < vertexCount; v++) {
      const c = gridCoord[v * 2];
      const r = gridCoord[v * 2 + 1];
      const list = [];
      for (const [dc, dr] of [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ]) {
        const nc = c + dc;
        const nr = r + dr;
        if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
        const n = vertexOf[nr * cols + nc];
        if (n >= 0) list.push(n);
      }
      neighbours.push(list);
    }

    for (let pass = 0; pass < RELAX_PASSES; pass++) {
      const next = new Float32Array(weights.length);
      for (let v = 0; v < vertexCount; v++) {
        const list = neighbours[v];
        for (let b = 0; b < boneCount; b++) {
          let sum = 0;
          for (const n of list) sum += weights[n * boneCount + b];
          const average = list.length ? sum / list.length : weights[v * boneCount + b];
          next[v * boneCount + b] =
            weights[v * boneCount + b] * (1 - RELAX_RATE) + average * RELAX_RATE;
        }
      }
      weights = next;
    }

    const boneIndex = [];
    const boneWeight = [];
    const offsets = [];
    for (let v = 0; v < vertexCount; v++) {
      const ranked = [];
      for (let b = 0; b < boneCount; b++) {
        const w = weights[v * boneCount + b];
        if (w > 0.0001) ranked.push([b, w]);
      }
      ranked.sort((a, b) => b[1] - a[1]);
      if (!ranked.length) ranked.push([0, 1]);

      const dominant = ranked[0][0];
      const top = ranked.slice(0, MAX_INFLUENCES);

      /**
       * Quantise here rather than on the way out. The rig ships weights rounded to
       * four places, and a vertex whose weights sum to 0.9999 is dragged a ten
       * thousandth of the way towards the root pivot - harmless on its own, but it
       * makes "weights sum to one" untrue, and an invariant that is only nearly true
       * cannot be asserted. Rounding now and handing the remainder to the dominant
       * influence means what ships sums to exactly one.
       */
      const total = top.reduce((sum, [, w]) => sum + w, 0);
      const quantised = top.map(([, w]) => Math.round((w / total) * 1e4) / 1e4);
      quantised[0] =
        Math.round((1 - quantised.slice(1).reduce((sum, w) => sum + w, 0)) * 1e4) / 1e4;

      for (let i = 0; i < MAX_INFLUENCES; i++) {
        // Padding slots repeat the dominant bone at zero weight, so every slot holds a
        // valid index and the runtime needs no bounds check in its inner loop.
        const b = top[i] ? top[i][0] : dominant;
        boneIndex.push(b);
        boneWeight.push(top[i] ? quantised[i] : 0);
        offsets.push(positions[v * 2] - bones[b].pivot.x, positions[v * 2 + 1] - bones[b].pivot.y);
      }
    }

    const uvs = [];
    for (let v = 0; v < vertexCount; v++) {
      uvs.push(positions[v * 2] / CANVAS.w, positions[v * 2 + 1] / CANVAS.h);
    }

    // --- coverage check ---------------------------------------------------------
    // Every bit of the drawing must fall inside a kept cell, or it is simply missing.
    let silhouettePixels = 0;
    let uncovered = 0;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (outside[y * CANVAS.w + x]) continue;
        silhouettePixels++;
        const c = Math.floor((x - originX) / GRID_STEP);
        const r = Math.floor((y - originY) / GRID_STEP);
        const covered =
          vertexOf[r * cols + c] >= 0 &&
          vertexOf[r * cols + c + 1] >= 0 &&
          vertexOf[(r + 1) * cols + c] >= 0 &&
          vertexOf[(r + 1) * cols + c + 1] >= 0;
        if (!covered) uncovered++;
      }
    }

    // --- debug view -------------------------------------------------------------
    const [dbg, dbgCtx] = make(CANVAS.w, CANVAS.h);
    dbgCtx.globalAlpha = 0.25;
    dbgCtx.drawImage(artCanvas, 0, 0);
    dbgCtx.globalAlpha = 1;
    const hues = ["#e0453a", "#e88a1e", "#c9b826", "#3fa64d", "#2f8fd0", "#7a54c8", "#d052a0", "#4aa79a"];
    for (let v = 0; v < vertexCount; v++) {
      // Colour each vertex by its dominant bone, faded by how dominant it is: a
      // washed-out patch is a smooth hand-off, a hard colour change is a hinge.
      const b = boneIndex[v * MAX_INFLUENCES];
      const w = boneWeight[v * MAX_INFLUENCES];
      dbgCtx.fillStyle = hues[b % hues.length];
      dbgCtx.globalAlpha = Math.max(0.12, Math.min(1, (w - 0.34) / 0.66));
      dbgCtx.fillRect(positions[v * 2] - 5, positions[v * 2 + 1] - 5, 10, 10);
    }
    dbgCtx.globalAlpha = 1;
    for (const bone of bones) {
      dbgCtx.fillStyle = "#000";
      dbgCtx.beginPath();
      dbgCtx.arc(bone.pivot.x, bone.pivot.y, 7, 0, Math.PI * 2);
      dbgCtx.fill();
    }

    return {
      placement,
      silhouette: silCanvas.toDataURL("image/png"),
      lineart: lineCanvas.toDataURL("image/png"),
      shade: shadeCanvas.toDataURL("image/png"),
      mesh: { vertexCount, positions, uvs, indices, boneIndex, boneWeight, offsets },
      silhouettePixels,
      uncovered,
      debug: dbg.toDataURL("image/png"),
    };
  },
  {
    bones,
    artworkDataUrl,
    CANVAS,
    PAPER_LEVEL,
    INK_FLOOR,
    SHADE_STRENGTH,
    SHADE_BLUR,
    SHADE_OFFSET,
    GRID_STEP,
    MAX_INFLUENCES,
    RELAX_PASSES,
    RELAX_RATE,
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

if (process.env.RIG_DEBUG) {
  writeFileSync(resolve(process.env.RIG_DEBUG), decode(built.debug));
  console.log(`  debug overlay -> ${process.env.RIG_DEBUG}`);
}

const byId = new Set(bones.map((b) => b.id));
for (const bone of bones) {
  if (bone.parent && !byId.has(bone.parent)) {
    throw new Error(`bone "${bone.id}" names unknown parent "${bone.parent}"`);
  }
}
if (bones.filter((b) => !b.parent).length !== 1) {
  throw new Error("expected exactly one root bone");
}

const root = bones.find((b) => !b.parent);
const { positions } = built.mesh;
let footDrop = -Infinity;
let left = Infinity;
let right = -Infinity;
for (let v = 0; v < built.mesh.vertexCount; v++) {
  footDrop = Math.max(footDrop, positions[v * 2 + 1] - root.pivot.y);
  left = Math.min(left, positions[v * 2] - root.pivot.x);
  right = Math.max(right, positions[v * 2] - root.pivot.x);
}

const round = (values, places) => values.map((n) => Number(n.toFixed(places)));

mkdirSync(resolve("world/rigs"), { recursive: true });
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
      bones: bones.map((b) => ({ id: b.id, parent: b.parent, pivot: b.pivot })),
      mesh: {
        vertexCount: built.mesh.vertexCount,
        influences: MAX_INFLUENCES,
        positions: round(built.mesh.positions, 2),
        uvs: round(built.mesh.uvs, 5),
        indices: built.mesh.indices,
        boneIndex: built.mesh.boneIndex,
        boneWeight: round(built.mesh.boneWeight, 4),
        offsets: round(built.mesh.offsets, 2),
      },
    },
    null,
    1,
  )}\n`,
);

const missed = (built.uncovered / built.silhouettePixels) * 100;
console.log(`${slug}: ${bones.length} bones, ${built.mesh.vertexCount} vertices -> ${outPath}`);
console.log(
  `  artwork ${Math.round(built.placement.w)}x${Math.round(built.placement.h)} ` +
    `at ${Math.round(built.placement.x)},${Math.round(built.placement.y)}`,
);
console.log(`  triangles ${built.mesh.indices.length / 3}, uncovered ${missed.toFixed(2)}%`);
if (missed > 0.5) {
  console.error(`  WARNING: ${missed.toFixed(2)}% of the drawing is outside the mesh.`);
}
