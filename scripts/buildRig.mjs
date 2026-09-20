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
 * This many reaches about three cells - a hip's width - which is the blend a rigger
 * would paint by hand: roughly half and half where the thigh meets the belly, and the
 * limb's own bone alone by the time you reach the foot.
 *
 * It was briefly 48, to stop the triangles between the two touching front feet from
 * turning inside out. That worked by softening every limb on the animal, which is why
 * the legs then bulged as they walked. Limb-to-limb leakage is blocked at the source
 * now, and the few triangles that genuinely bridge two limbs are cut instead, so the
 * blend is free to go back to being a hip's width.
 */
const RELAX_PASSES = 18;
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

    let indices = [];
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
    /** Which bone each vertex started out belonging to, before any relaxation. */
    const seedOwner = new Int32Array(vertexCount);
    /** 1 where a vertex sits on blank paper rather than on the drawing. */
    const onPaper = new Uint8Array(vertexCount);
    const isLimb = (index) => bones[index].id.startsWith("leg");

    const gridNeighbours = (v) => {
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
      return list;
    };

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
      seedOwner[v] = owner;
      onPaper[v] = inside(x, y) ? 0 : 1;
    }

    /**
     * A vertex out on the paper takes the limb it sits BESIDE, not the one whose
     * pivot happens to be closest.
     *
     * Cells are kept whenever any corner is inside the drawing, so the mesh carries a
     * ring of vertices over blank paper - including the gaps between the legs. Seeded
     * by nearest pivot, a vertex halfway between two feet gets handed to whichever
     * hip is nearer, which can be the leg on the far side of the gap; the boundary
     * triangles of one leg then pull towards the other. Copying the nearest vertex
     * that IS in the drawing keeps each one with the limb it actually borders.
     */
    // Spread outwards from the drawing a ring at a time, so a vertex two cells out on
    // the paper still ends up with the limb it borders. `onPaper` itself is left
    // alone - the seam check below needs to know which vertices carry no ink.
    const settled = onPaper.map((paper) => (paper ? 0 : 1));
    for (let pass = 0; pass < 4; pass++) {
      const updated = seedOwner.slice();
      const reached = [];
      for (let v = 0; v < vertexCount; v++) {
        if (settled[v]) continue;
        let bestDistance = Infinity;
        for (const n of gridNeighbours(v)) {
          if (!settled[n]) continue;
          const d =
            (positions[n * 2] - positions[v * 2]) ** 2 +
            (positions[n * 2 + 1] - positions[v * 2 + 1]) ** 2;
          if (d < bestDistance) {
            bestDistance = d;
            updated[v] = seedOwner[n];
          }
        }
        if (bestDistance < Infinity) reached.push(v);
      }
      seedOwner.set(updated);
      for (const v of reached) settled[v] = 1;
    }
    for (let v = 0; v < vertexCount; v++) {
      weights.fill(0, v * boneCount, (v + 1) * boneCount);
      weights[v * boneCount + seedOwner[v]] = 1;
    }

    // Relax: replace each vertex's weights with a blend of its grid neighbours'.
    const neighbours = [];
    for (let v = 0; v < vertexCount; v++) {
      const list = [];
      for (const n of gridNeighbours(v)) {
        /**
         * Weight never crosses from one limb to another.
         *
         * Relaxation walks the grid, and the grid knows nothing about anatomy: two
         * legs that pass within a cell of each other on the page are neighbours as
         * far as it is concerned, however far apart they are along the body. Left
         * alone it pours weight straight across the gap, and since a near leg and a
         * far leg swing in OPPOSITE directions, every vertex in between ends up
         * dragged two ways at once. That is what makes a leg bulge and bend as it
         * walks instead of swinging.
         *
         * Blocking these few edges - seven on the whole Triceratops - takes a leg
         * vertex from keeping 0.54 of its own bone to keeping 0.82. A hip is
         * untouched, because a thigh and a belly are not two limbs: weight still
         * flows freely there, which is what keeps the hip soft.
         */
        if (isLimb(seedOwner[v]) && isLimb(seedOwner[n]) && seedOwner[v] !== seedOwner[n]) {
          continue;
        }
        list.push(n);
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
    const rootBone = bones.findIndex((bone) => !bone.parent);

    for (let v = 0; v < vertexCount; v++) {
      /**
       * A vertex may follow at most ONE limb.
       *
       * Two limbs in opposite phase pull a shared vertex two ways at once, and the
       * belly between a pair of legs is full of such vertices. They are seeded to the
       * body, so the limb-to-limb block above never sees them - but they relay between
       * the two legs all the same, and end up carrying a third of one and a sixth of
       * the other. The scrap of belly line they hold then tears away from the rest of
       * it as the legs pass.
       *
       * Splitting a vertex between two limbs is never the right answer, so the weaker
       * limb's share goes to the thing both of them hang off: the body.
       */
      let strongest = -1;
      for (let b = 0; b < boneCount; b++) {
        if (!isLimb(b) || weights[v * boneCount + b] <= 0) continue;
        if (strongest < 0 || weights[v * boneCount + b] > weights[v * boneCount + strongest]) {
          strongest = b;
        }
      }
      if (strongest >= 0) {
        for (let b = 0; b < boneCount; b++) {
          if (!isLimb(b) || b === strongest) continue;
          weights[v * boneCount + rootBone] += weights[v * boneCount + b];
          weights[v * boneCount + b] = 0;
        }
      }

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

    const dominantOf = (v) => boneIndex[v * MAX_INFLUENCES];

    /**
     * Where two limbs meet on the sheet, cut the mesh.
     *
     * A triangle reaching into two different limbs has to absorb their whole relative
     * swing, and a near leg and a far leg swing in opposite directions - so it
     * stretches, folds and eventually turns inside out, which renders as black shards
     * flickering between the feet. No choice of weights avoids it: the two ends of the
     * triangle simply have to be in two places at once.
     *
     * So it stops being one triangle spanning two limbs and becomes a triangle
     * belonging to one. The limb drawn IN FRONT takes it, because at an overlap its
     * pixels are the ones you can actually see; the limb behind gives up at most a
     * cell of geometry, where it is hidden anyway. Vertices are copied rather than
     * rebound, so the neighbouring triangles keep the blend that softens their hip.
     *
     * All three corners, not just the ones that disagree: a triangle with two rigid
     * corners and one blended corner still deforms. Rigid on all three makes it a
     * plain rotation, and a rotation cannot change a triangle's area at all.
     *
     * On a sheet whose limbs never touch this finds nothing to do, which is the point
     * - see the assertion below.
     */
    const rigidCopies = new Map();
    const seams = [];
    for (let t = 0; t < indices.length; t += 3) {
      const corners = [indices[t], indices[t + 1], indices[t + 2]];
      const limbs = [...new Set(corners.map(dominantOf).filter(isLimb))];
      if (limbs.length < 2) continue;

      /**
       * Two different questions, two different tests.
       *
       * The CUT applies to every triangle reaching into two limbs, paper corners and
       * all: even in the empty gap between two feet, one corner following the near leg
       * and another following the far leg will fold the triangle over, and a folded
       * triangle mirrors whatever ink its cell does contain.
       *
       * The ASSERTION at the end is about the DRAWING, so it only counts corners that
       * carry ink. The grid keeps a ring of vertices out on blank paper so boundary
       * cells have corners; those say nothing about whether two limbs touch, and
       * failing a sheet over them would make the rule impossible to satisfy - there is
       * always a point in the gap where the nearer limb changes.
       */
      if (corners.filter((v) => !onPaper[v]).map(dominantOf).filter(isLimb).length > 1) {
        seams.push({
          x: Math.round(positions[corners[0] * 2]),
          y: Math.round(positions[corners[0] * 2 + 1]),
          limbs: limbs.map((b) => bones[b].id),
        });
      }

      /**
       * The ink decides who keeps the triangle - by weight, not by a show of hands.
       *
       * A bridging triangle in the gap between two limbs is mostly blank paper, but it
       * still catches the edge of whatever runs past it, which near a hip is the belly
       * line. Handing it to a limb because one inked corner happens to lean that way
       * sends that scrap of belly flying off with the leg, leaving a notch behind - a
       * worse artefact than the fold it was meant to cure.
       *
       * So the owner is whichever bone holds the most weight across the inked corners.
       * A scrap of belly stays with the body; an overlap of two limbs goes to the limb
       * that actually owns the pixels, and `data-z` only breaks a tie.
       */
      const ink = corners.filter((v) => !onPaper[v]);
      const pool = ink.length ? ink : corners;
      const held = new Float64Array(boneCount);
      for (const v of pool) {
        for (let i = 0; i < MAX_INFLUENCES; i++) {
          held[boneIndex[v * MAX_INFLUENCES + i]] += boneWeight[v * MAX_INFLUENCES + i];
        }
      }
      let owner = 0;
      for (let b = 1; b < boneCount; b++) {
        const better =
          held[b] > held[owner] || (held[b] === held[owner] && bones[b].z > bones[owner].z);
        if (better) owner = b;
      }
      for (let k = 0; k < 3; k++) {
        const v = corners[k];
        const cacheKey = `${v}:${owner}`;
        let copy = rigidCopies.get(cacheKey);
        if (copy === undefined) {
          copy = positions.length / 2;
          positions.push(positions[v * 2], positions[v * 2 + 1]);
          for (let i = 0; i < MAX_INFLUENCES; i++) {
            boneIndex.push(owner);
            boneWeight.push(i === 0 ? 1 : 0);
            offsets.push(
              positions[copy * 2] - bones[owner].pivot.x,
              positions[copy * 2 + 1] - bones[owner].pivot.y,
            );
          }
          rigidCopies.set(cacheKey, copy);
        }
        indices[t + k] = copy;
      }
    }

    /**
     * Draw back to front, by the z the skeleton already declares.
     *
     * One mesh has no depth test, so what paints last wins, and that is index order.
     * Left in the order the grid happened to produce - row by row, left to right -
     * a far leg swinging forward paints over the near leg it should pass behind.
     * Sorting by the dominant bone's z reproduces the drawing's own layering: tail,
     * body, far legs, near legs, head. Stable, so within one bone the grid order and
     * its cache behaviour survive.
     */
    const triangles = [];
    for (let t = 0; t < indices.length; t += 3) {
      let z = -Infinity;
      for (let k = 0; k < 3; k++) z = Math.max(z, bones[dominantOf(indices[t + k])].z);
      triangles.push({ t, z, order: triangles.length });
    }
    triangles.sort((a, b) => a.z - b.z || a.order - b.order);
    const sortedIndices = [];
    for (const { t } of triangles) {
      sortedIndices.push(indices[t], indices[t + 1], indices[t + 2]);
    }
    indices = sortedIndices;

    const meshVertexCount = positions.length / 2;
    const uvs = [];
    for (let v = 0; v < meshVertexCount; v++) {
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
      mesh: {
        vertexCount: meshVertexCount,
        gridVertexCount: vertexCount,
        positions,
        uvs,
        indices,
        boneIndex,
        boneWeight,
        offsets,
      },
      seams,
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
        gridVertexCount: built.mesh.gridVertexCount,
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

/**
 * No triangle may reach into two different limbs.
 *
 * This is the sheet's contract with the rig, and it is a property of the DRAWING, not
 * of anything the solver can fix afterwards. Two limbs that touch on the paper share
 * mesh, and they swing in opposite directions, so the triangles between them are asked
 * to be in two places at once: they stretch, fold, invert, and render as black shards
 * between the feet. Weights can soften it, but softening every limb on the animal to
 * do so is what made the legs bulge as they walked.
 *
 * So the drawing has to keep its limbs apart - about 40 canonical pixels, a little
 * over a grid step, which is the furthest one triangle can reach. Checked here rather
 * than trusted, because the failure is invisible in the artwork and only shows up as
 * a flicker once something is walking.
 *
 * The cut above still runs, and still resolves anything that does slip through, but
 * this failing means a sheet needs redrawing rather than a rig needs tuning.
 */
if (built.seams.length) {
  const where = built.seams
    .slice(0, 6)
    .map((s) => `${s.limbs.join(" + ")} at ${s.x},${s.y}`)
    .join("\n    ");
  console.error(
    `\n  ${slug}: ${built.seams.length} triangles reach into two limbs at once.\n` +
      `  The drawing has limbs touching, which no amount of rigging survives.\n` +
      `  Separate them on the sheet by ~40 canonical px and rebuild.\n    ${where}` +
      (built.seams.length > 6 ? `\n    ...and ${built.seams.length - 6} more` : ""),
  );
  process.exit(1);
}
if (missed > 0.5) {
  console.error(`  WARNING: ${missed.toFixed(2)}% of the drawing is outside the mesh.`);
}
