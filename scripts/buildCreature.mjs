/**
 * Give the printed drawing a third dimension.
 *
 *   world/rigs/<slug>.json + its part masks
 *     -> public/assets/dino/<slug>/creature.bin   one skinned mesh
 *     -> world/creatures/<slug>.json              its header and skeleton
 *
 * Why inflate the drawing instead of modelling a dinosaur: the drawing is the only
 * authority on what this animal looks like, a child is about to colour it, and a
 * modelled dinosaur would have to be matched back to it by hand for every species. A
 * volume swept from the drawing's own silhouette reproduces it exactly in side view -
 * which is the view the installation is in - and only has to be plausible from anywhere
 * else.
 *
 * The reason this is worth doing at all: five revisions of the 2D rig failed in the same
 * place, because a flat drawing has no outline where a limb enters the body. Nobody drew
 * one. In three dimensions there is nothing to draw: the mesh is continuous, so there is
 * no cut to hide, and the outline is generated from the real silhouette every frame.
 *
 * The parts already overlap - each limb's mask carries on under the belly, which two
 * revisions were spent getting right - and that overlap is exactly what a smooth union
 * needs to fuse them into one surface with a rounded joint instead of a crease.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { PNG } from "pngjs";

const slug = process.argv[2] ?? "triceratops";

/** Grid step, canonical pixels. Smaller is smoother and quadratically slower. */
const STEP = 7;
/** How far the volume reaches either side of the page. */
const DEPTH = 190;
/**
 * How the local half-width is estimated: the widest the drawing gets within this many
 * pixels. Larger rounds the creature out, smaller flattens it towards cardboard.
 */
const RADIUS_WINDOW = 30;
/** Thickness multiplier. 1 is a circular cross-section; less keeps it papery. */
const DEPTH_SCALE = 0.9;
/** How softly the parts fuse where they overlap, in pixels. */
const FUSE = 26;
/**
 * How far apart in depth the near and far legs sit.
 *
 * Wide enough that the two never share a vertex. When they were closer their influences
 * interpenetrated and a patch of skin between them followed both at once - which, since
 * a diagonal gait swings them in opposite phase, is precisely the shear that five
 * revisions of the flat rig kept producing.
 */
const LEG_SPLAY = 88;
/**
 * How sharply a bone's influence falls off with distance. Higher is a tighter, more
 * rigid joint; lower spreads the bend further up the body.
 */
const WEIGHT_FALLOFF = 2;
/** Softens the weight near a bone, so a vertex sitting on one is not infinitely heavy. */
const WEIGHT_FLOOR = 60;

const rig = JSON.parse(readFileSync(resolve(`world/rigs/${slug}.json`), "utf8"));
const { w: W, h: H } = rig.texture;

/** Depth each part sits at, so the near pair is in front of the far pair. */
function depthOf(id) {
  if (id.includes("Near")) return LEG_SPLAY;
  if (id.includes("Far")) return -LEG_SPLAY;
  return 0;
}

// --- each part as a signed distance field on the page ------------------------------
/** Squared distance transform of one row, Felzenszwalb & Huttenlocher. Exact. */
function edt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

function distanceTo(seed) {
  const f = new Float64Array(Math.max(W, H));
  const d = new Float64Array(Math.max(W, H));
  const v = new Int32Array(Math.max(W, H));
  const z = new Float64Array(Math.max(W, H) + 1);
  const out = new Float64Array(W * H);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) f[x] = seed[y * W + x] ? 0 : 1e12;
    edt1d(f, W, d, v, z);
    for (let x = 0; x < W; x++) out[y * W + x] = d[x];
  }
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) f[y] = out[y * W + x];
    edt1d(f, H, d, v, z);
    for (let y = 0; y < H; y++) out[y * W + x] = Math.sqrt(d[y]);
  }
  return out;
}

/** The widest the region gets within RADIUS_WINDOW, as a separable sliding maximum. */
function localMax(field, radius) {
  const pass = new Float64Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let best = 0;
      for (let i = Math.max(0, x - radius); i <= Math.min(W - 1, x + radius); i++) {
        const value = field[y * W + i];
        if (value > best) best = value;
      }
      pass[y * W + x] = best;
    }
  }
  const out = new Float64Array(W * H);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      let best = 0;
      for (let i = Math.max(0, y - radius); i <= Math.min(H - 1, y + radius); i++) {
        const value = pass[i * W + x];
        if (value > best) best = value;
      }
      out[y * W + x] = best;
    }
  }
  return out;
}

/**
 * Where a part's bone runs, taken from the drawing rather than authored.
 *
 * The rig knows each joint but not how long the thing hanging off it is, so take the
 * part's own longest axis: for a leg that is hip to foot, for the body tail to chest,
 * for the head the frill to the horns. A principal axis over the mask's pixels gives it
 * directly, and it means a new species needs no numbers typed in.
 */
function boneSegment(inside, pivot, isRoot) {
  let n = 0;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < inside.length; i++) {
    if (!inside[i]) continue;
    n++;
    mx += i % W;
    my += (i / W) | 0;
  }
  mx /= n;
  my /= n;

  let xx = 0;
  let xy = 0;
  let yy = 0;
  for (let i = 0; i < inside.length; i++) {
    if (!inside[i]) continue;
    const dx = (i % W) - mx;
    const dy = ((i / W) | 0) - my;
    xx += dx * dx;
    xy += dx * dy;
    yy += dy * dy;
  }
  // Principal eigenvector of a symmetric 2x2.
  const theta = 0.5 * Math.atan2(2 * xy, xx - yy);
  const ax = Math.cos(theta);
  const ay = Math.sin(theta);

  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < inside.length; i++) {
    if (!inside[i]) continue;
    const t = ((i % W) - mx) * ax + (((i / W) | 0) - my) * ay;
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }

  const far = { x: mx + ax * hi, y: my + ay * hi };
  const near = { x: mx + ax * lo, y: my + ay * lo };

  // The root does not hinge at a joint - it IS the torso - so its bone runs the whole
  // length, nose to tail. Everything else is anchored at the joint the rig already
  // knows, so the bone starts where the animal actually bends rather than at the middle
  // of a blob of pixels.
  if (isRoot) return { from: near, to: far };

  const pick = Math.hypot(far.x - pivot.x, far.y - pivot.y) >
    Math.hypot(near.x - pivot.x, near.y - pivot.y)
    ? far
    : near;
  return { from: { x: pivot.x, y: pivot.y }, to: pick };
}

/** Distance from a point to the part's bone, in three dimensions. */
function distanceToBone(part, x, y, z) {
  const { from, to } = part.bone;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((x - from.x) * dx + (y - from.y) * dy) / length));
  return Math.hypot(x - (from.x + dx * t), y - (from.y + dy * t), z - part.z);
}

const parts = rig.parts.map((part) => {
  const png = PNG.sync.read(readFileSync(resolve("public" + part.mask)));
  const inside = new Uint8Array(W * H);
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      if (png.data[(y * png.width + x) * 4 + 3] <= 128) continue;
      const px = x + part.box.x;
      const py = y + part.box.y;
      if (px >= 0 && py >= 0 && px < W && py < H) inside[py * W + px] = 1;
    }
  }

  // Positive inside the region, negative outside, in pixels.
  const outward = distanceTo(inside);
  const flipped = new Uint8Array(W * H);
  for (let i = 0; i < inside.length; i++) flipped[i] = inside[i] ? 0 : 1;
  const inward = distanceTo(flipped);
  const signed = new Float64Array(W * H);
  for (let i = 0; i < signed.length; i++) signed[i] = inside[i] ? inward[i] : -outward[i];

  return {
    id: part.id,
    limb: part.id.startsWith("leg"),
    signed,
    radius: localMax(inward, RADIUS_WINDOW),
    z: depthOf(part.id),
    bone: boneSegment(inside, part.pivot, part.parent === null),
  };
});


// --- the field ---------------------------------------------------------------------
/** Bilinear sample, clamped at the page edge. */
function sample(field, x, y) {
  const cx = Math.min(W - 1.001, Math.max(0, x));
  const cy = Math.min(H - 1.001, Math.max(0, y));
  const x0 = cx | 0;
  const y0 = cy | 0;
  const fx = cx - x0;
  const fy = cy - y0;
  const a = field[y0 * W + x0];
  const b = field[y0 * W + x0 + 1];
  const c = field[(y0 + 1) * W + x0];
  const d = field[(y0 + 1) * W + x0 + 1];
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/** Polynomial smooth minimum: fuses two surfaces into one instead of creasing them. */
function smin(a, b, k) {
  const h = Math.max(0, k - Math.abs(a - b)) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/**
 * One part's distance to its own surface: inside the drawn region and within the
 * thickness the region's width implies. The cross-section is a circle of the local
 * half-width, flattened by DEPTH_SCALE, so the animal keeps some of the page's
 * flatness instead of reading as a balloon.
 */
function partField(part, x, y, z) {
  const d = sample(part.signed, x, y);
  if (d <= 0) return -d;
  const r = Math.max(d, sample(part.radius, x, y));
  const half = Math.sqrt(Math.max(0, d * (2 * r - d))) * DEPTH_SCALE;
  return Math.max(-d, Math.abs(z - part.z) - half);
}

function field(x, y, z) {
  let value = Infinity;
  for (const part of parts) value = smin(value, partField(part, x, y, z), FUSE);
  return value;
}

// --- surface nets --------------------------------------------------------------------
/**
 * Dual contouring's simple cousin: one vertex per cell that straddles the surface,
 * placed at the average of the crossings on its edges, and a quad for every grid edge
 * that crosses. No lookup tables, always watertight, and it comes out smoother than
 * marching cubes on a grid this coarse.
 */
const pad = STEP * 3;
const lo = { x: -pad, y: -pad, z: -DEPTH };
const nx = Math.ceil((W + 2 * pad) / STEP);
const ny = Math.ceil((H + 2 * pad) / STEP);
const nz = Math.ceil((2 * DEPTH) / STEP);

const gx = nx + 1;
const gy = ny + 1;
const gz = nz + 1;
const grid = new Float32Array(gx * gy * gz);
const at = (i, j, k) => (k * gy + j) * gx + i;

for (let k = 0; k < gz; k++) {
  for (let j = 0; j < gy; j++) {
    for (let i = 0; i < gx; i++) {
      grid[at(i, j, k)] = field(lo.x + i * STEP, lo.y + j * STEP, lo.z + k * STEP);
    }
  }
}

const cellVertex = new Int32Array(nx * ny * nz).fill(-1);
const cellAt = (i, j, k) => (k * ny + j) * nx + i;
const positions = [];
const CORNERS = [
  [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
  [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
];
const EDGES = [
  [0, 1], [2, 3], [4, 5], [6, 7],
  [0, 2], [1, 3], [4, 6], [5, 7],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

for (let k = 0; k < nz; k++) {
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const corner = CORNERS.map(([a, b, c]) => grid[at(i + a, j + b, k + c)]);
      let inside = 0;
      for (const value of corner) if (value < 0) inside++;
      if (inside === 0 || inside === 8) continue;

      let sx = 0;
      let sy = 0;
      let sz = 0;
      let hits = 0;
      for (const [a, b] of EDGES) {
        if (corner[a] < 0 === corner[b] < 0) continue;
        const t = corner[a] / (corner[a] - corner[b]);
        sx += CORNERS[a][0] + (CORNERS[b][0] - CORNERS[a][0]) * t;
        sy += CORNERS[a][1] + (CORNERS[b][1] - CORNERS[a][1]) * t;
        sz += CORNERS[a][2] + (CORNERS[b][2] - CORNERS[a][2]) * t;
        hits++;
      }
      cellVertex[cellAt(i, j, k)] = positions.length / 3;
      positions.push(
        lo.x + (i + sx / hits) * STEP,
        lo.y + (j + sy / hits) * STEP,
        lo.z + (k + sz / hits) * STEP,
      );
    }
  }
}

const indices = [];
/**
 * The vertex a cell contributed, or -1 if there is no such cell.
 *
 * The bounds check is the whole of it. Indexing a cell past the end does not fail - it
 * folds round into the next slice and hands back a real vertex from somewhere else
 * entirely - so a quad on the far boundary would stitch itself to a point halfway
 * across the animal. That is what put long flat blades through the hip and tore a hole
 * beside them, and it was there in the rest pose all along, hidden under the texture.
 */
const vertexOf = (i, j, k) => {
  if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return -1;
  return cellVertex[cellAt(i, j, k)];
};

const quad = (a, b, c, d, flip) => {
  if (a < 0 || b < 0 || c < 0 || d < 0) return;
  // Wound so the front face is the one whose normal points out of the surface, which
  // is what lets the outline hull render backfaces and end up behind the skin.
  if (flip) indices.push(a, c, b, a, d, c);
  else indices.push(a, b, c, a, c, d);
};

for (let k = 0; k < gz; k++) {
  for (let j = 0; j < gy; j++) {
    for (let i = 0; i < gx; i++) {
      const here = grid[at(i, j, k)] < 0;
      if (i + 1 < gx && here !== grid[at(i + 1, j, k)] < 0) {
        quad(
          vertexOf(i, j - 1, k - 1),
          vertexOf(i, j, k - 1),
          vertexOf(i, j, k),
          vertexOf(i, j - 1, k),
          here,
        );
      }
      if (j + 1 < gy && here !== grid[at(i, j + 1, k)] < 0) {
        quad(
          vertexOf(i - 1, j, k - 1),
          vertexOf(i, j, k - 1),
          vertexOf(i, j, k),
          vertexOf(i - 1, j, k),
          !here,
        );
      }
      if (k + 1 < gz && here !== grid[at(i, j, k + 1)] < 0) {
        quad(
          vertexOf(i - 1, j - 1, k),
          vertexOf(i, j - 1, k),
          vertexOf(i, j, k),
          vertexOf(i - 1, j, k),
          here,
        );
      }
    }
  }
}

// --- normals, texture coordinates and skin ------------------------------------------
/**
 * Normals from the field's own gradient rather than from the triangles: the grid is
 * coarse, and a gradient normal is the surface the field describes rather than the
 * faceting of the mesh that approximates it.
 */
const count = positions.length / 3;
const normals = new Float32Array(count * 3);
const uvs = new Float32Array(count * 2);
const skinIndex = new Uint16Array(count * 4);
const skinWeight = new Float32Array(count * 4);
const eps = STEP * 0.5;

for (let v = 0; v < count; v++) {
  const x = positions[v * 3];
  const y = positions[v * 3 + 1];
  const z = positions[v * 3 + 2];

  let gxv = field(x + eps, y, z) - field(x - eps, y, z);
  let gyv = field(x, y + eps, z) - field(x, y - eps, z);
  let gzv = field(x, y, z + eps) - field(x, y, z - eps);
  const length = Math.hypot(gxv, gyv, gzv) || 1;
  // Y is negated on the way out, so the normal is too.
  normals[v * 3] = gxv / length;
  normals[v * 3 + 1] = -gyv / length;
  normals[v * 3 + 2] = gzv / length;

  // The drawing, projected straight along the view axis. Rest position, so the crayon
  // is glued to the surface and travels with it once the mesh is posed.
  // Straight through, with no vertical flip: the texture is uploaded unflipped, so a
  // row of the sheet is a row of the texture and the page's own y works as it is.
  uvs[v * 2] = (x - rig.artwork.x) / rig.artwork.w;
  uvs[v * 2 + 1] = (y - rig.artwork.y) / rig.artwork.h;

  // Weighted by distance to the BONE, not by the volume fields that built the surface.
  // The fields are what fuse the parts into one skin and they reach a long way inside
  // each other by design - a leg carries on well up into the torso - so using them here
  // had the belly following a leg around. A bone is where the animal actually bends.
  const scored = parts.map((part, index) => ({
    index,
    limb: part.limb,
    w: 1 / Math.pow(distanceToBone(part, x, y, z) + WEIGHT_FLOOR, WEIGHT_FALLOFF),
  }));

  const kept = scored.filter((entry) => entry.w > 0).sort((a, b) => b.w - a.w).slice(0, 4);
  const total = kept.reduce((sum, entry) => sum + entry.w, 0);
  for (let i = 0; i < 4; i++) {
    skinIndex[v * 4 + i] = kept[i] ? kept[i].index : 0;
    skinWeight[v * 4 + i] = kept[i] ? kept[i].w / total : 0;
  }
}

const position = new Float32Array(count * 3);
for (let v = 0; v < count; v++) {
  position[v * 3] = positions[v * 3];
  position[v * 3 + 1] = -positions[v * 3 + 1];
  position[v * 3 + 2] = positions[v * 3 + 2];
}
const index = new Uint32Array(indices);

// --- out -----------------------------------------------------------------------------
mkdirSync(resolve(`public/assets/dino/${slug}`), { recursive: true });
mkdirSync(resolve("world/creatures"), { recursive: true });

const chunks = [position, normals, uvs, skinIndex, skinWeight, index];
const total = chunks.reduce((n, c) => n + c.byteLength, 0);
const bin = Buffer.alloc(total);
let offset = 0;
const layout = {};
const names = ["position", "normal", "uv", "skinIndex", "skinWeight", "index"];
chunks.forEach((chunk, i) => {
  Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).copy(bin, offset);
  layout[names[i]] = { offset, length: chunk.length };
  offset += chunk.byteLength;
});
writeFileSync(resolve(`public/assets/dino/${slug}/creature.bin`), bin);

writeFileSync(
  resolve(`world/creatures/${slug}.json`),
  JSON.stringify(
    {
      slug,
      mesh: `/assets/dino/${slug}/creature.bin`,
      vertices: count,
      triangles: index.length / 3,
      layout,
      // Bones in the same order as the skin indices, which is rig order.
      bones: rig.parts.map((part) => ({
        id: part.id,
        parent: part.parent,
        head: { x: part.pivot.x, y: -part.pivot.y, z: depthOf(part.id) },
      })),
      footDrop: rig.footDrop,
      extent: rig.extent,
      artwork: rig.artwork,
      texture: rig.texture,
    },
    null,
    2,
  ) + "\n",
);

console.log(`${slug}: ${count} vertices, ${index.length / 3} triangles`);
for (const part of parts) {
  console.log(
    `  ${part.id.padEnd(13)} bone ${Math.round(part.bone.from.x)},${Math.round(part.bone.from.y)}` +
      ` -> ${Math.round(part.bone.to.x)},${Math.round(part.bone.to.y)}  z${part.z}`,
  );
}
console.log(`  grid ${gx}x${gy}x${gz} at ${STEP}px, depth +-${DEPTH}`);
console.log(`  -> public/assets/dino/${slug}/creature.bin  ${Math.round(total / 1024)}KB`);
