import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import creatureData from "@/world/creatures/triceratops.json";
import rigData from "@/world/rigs/triceratops.json";

/**
 * Invariants of the inflated creature.
 *
 * Every defect this file pins was found by eye, late, after being blamed on something
 * else first - blades through the hip put there by an out-of-range cell lookup, a
 * fringe of notches along the belly put there by a field that was not a distance. Both
 * were in the REST pose the whole time, and both were invisible under a texture. So
 * these read the built artefact and ask about the surface itself.
 */

const rig = rigData as {
  texture: { w: number; h: number };
  artwork: { x: number; y: number; w: number; h: number };
  layers: { silhouette: string };
};

const creature = creatureData as {
  vertices: number;
  triangles: number;
  layout: Record<string, { offset: number; length: number }>;
  bones: { id: string }[];
};

/** The mesh, read back out of the binary the build writes. */
const mesh = (() => {
  const file = readFileSync(
    resolve(__dirname, "../public/assets/dino/triceratops/creature.bin"),
  );
  // Copied rather than viewed: a Buffer from disk carries whatever byte offset the
  // pool gave it, which is not necessarily aligned for a Float32Array.
  const bytes = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
  const { layout } = creature;
  return {
    position: new Float32Array(bytes, layout.position.offset, layout.position.length),
    uv: new Float32Array(bytes, layout.uv.offset, layout.uv.length),
    skinIndex: new Uint16Array(bytes, layout.skinIndex.offset, layout.skinIndex.length),
    skinWeight: new Float32Array(bytes, layout.skinWeight.offset, layout.skinWeight.length),
    index: new Uint32Array(bytes, layout.index.offset, layout.index.length),
  };
})();

describe("the surface is closed", () => {
  /**
   * Surface nets over a consistent field gives a watertight manifold, so a boundary
   * edge is never cosmetic: it means the field or the stitching is wrong. The blades
   * through the hip were an edge quad reaching into a cell that did not exist, which
   * folded round the array and stitched the surface to a point halfway across the
   * animal.
   */
  const edges = new Map<number, number>();
  let degenerate = 0;
  for (let t = 0; t < mesh.index.length; t += 3) {
    const tri = [mesh.index[t], mesh.index[t + 1], mesh.index[t + 2]];
    if (tri[0] === tri[1] || tri[1] === tri[2] || tri[0] === tri[2]) {
      degenerate++;
      continue;
    }
    for (let e = 0; e < 3; e++) {
      const a = tri[e];
      const b = tri[(e + 1) % 3];
      const key = a < b ? a * creature.vertices + b : b * creature.vertices + a;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }

  it("has no degenerate triangles", () => {
    expect(degenerate).toBe(0);
  });

  it("has no boundary: every edge is shared by two faces", () => {
    let open = 0;
    for (const uses of edges.values()) if (uses === 1) open++;
    expect(open, `${open} edges belong to only one face, so the surface has a hole`)
      .toBe(0);
  });

  it("is pinched in only a handful of places", () => {
    // An edge with more than two faces is two sheets of surface sharing a cell where
    // the animal nearly touches itself. The surface stays closed, and halving the grid
    // step only makes the near-contact thinner, so this is a budget rather than a ban.
    let pinched = 0;
    for (const uses of edges.values()) if (uses > 2) pinched++;
    expect(pinched, `${pinched} pinched edges`).toBeLessThan(40);
  });
});

describe("the skin is well formed", () => {
  it("weights every vertex, summing to one, on bones that exist", () => {
    for (let v = 0; v < creature.vertices; v++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        const weight = mesh.skinWeight[v * 4 + k];
        expect(Number.isFinite(weight), `vertex ${v} weight ${k}`).toBe(true);
        expect(weight).toBeGreaterThanOrEqual(0);
        expect(mesh.skinIndex[v * 4 + k]).toBeLessThan(creature.bones.length);
        sum += weight;
      }
      expect(sum, `vertex ${v} weights do not sum to one`).toBeCloseTo(1, 4);
    }
  });

  it("puts every bone to work", () => {
    // A bone nothing is bound to is a limb that will not move, and the gait will drive
    // it silently.
    const used = new Set<number>();
    for (let i = 0; i < mesh.skinIndex.length; i++) {
      if (mesh.skinWeight[i] > 0.01) used.add(mesh.skinIndex[i]);
    }
    for (let b = 0; b < creature.bones.length; b++) {
      expect(used.has(b), `nothing is skinned to ${creature.bones[b].id}`).toBe(true);
    }
  });

  it("has both flanks", () => {
    // Side on, a collapsed volume looks identical to a good one.
    let front = 0;
    let back = 0;
    for (let v = 0; v < creature.vertices; v++) {
      const z = mesh.position[v * 3 + 2];
      if (z > 20) front++;
      else if (z < -20) back++;
    }
    expect(front).toBeGreaterThan(creature.vertices / 8);
    expect(back).toBeGreaterThan(creature.vertices / 8);
  });
});

describe("the volume is faithful to the drawing", () => {
  /**
   * The claim of the whole approach: the creature is the drawing given depth, so seen
   * from the page it should BE the drawing. Nothing checked that, and the bill came in
   * indirectly - a field that was not a distance let the union swell tens of pixels
   * past the outline, which cost an unlimited colour bleed and an outline margin wide
   * enough to eat the ends off the interior lines, neither of which named the cause.
   */
  const { w, h } = rig.texture;

  /** Distance from each pixel out to the drawn silhouette; zero inside it. */
  const away = (() => {
    const png = PNG.sync.read(
      readFileSync(resolve(__dirname, "../public" + rig.layers.silhouette)),
    );
    const d = new Float64Array(w * h);
    for (let i = 0; i < w * h; i++) d[i] = png.data[i * 4 + 3] > 128 ? 0 : 1e9;

    // Two-pass chamfer. Not exact, and does not need to be: it answers "how far out",
    // to within a percent or so.
    const near = (i: number, v: number) => {
      if (v < d[i]) d[i] = v;
    };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (x > 0) near(i, d[i - 1] + 1);
        if (y > 0) near(i, d[i - w] + 1);
        if (x > 0 && y > 0) near(i, d[i - w - 1] + 1.414);
        if (x < w - 1 && y > 0) near(i, d[i - w + 1] + 1.414);
      }
    }
    for (let y = h - 1; y >= 0; y--) {
      for (let x = w - 1; x >= 0; x--) {
        const i = y * w + x;
        if (x < w - 1) near(i, d[i + 1] + 1);
        if (y < h - 1) near(i, d[i + w] + 1);
        if (x < w - 1 && y < h - 1) near(i, d[i + w + 1] + 1.414);
        if (x > 0 && y < h - 1) near(i, d[i + w - 1] + 1.414);
      }
    }
    return d;
  })();

  it("keeps every vertex on or just outside the drawn silhouette", () => {
    // The build reaches 5.7px. The budget has room for a grid step or a rim tweak and
    // none for the field going wrong again: before the extrusion distance was
    // corrected, the same measurement ran to tens of pixels.
    const BUDGET = 12;

    let worst = 0;
    let offPage = 0;
    for (let v = 0; v < creature.vertices; v++) {
      const x = Math.round(mesh.position[v * 3]);
      // Y is negated on the way out of the build, so it comes back the same way.
      const y = Math.round(-mesh.position[v * 3 + 1]);
      if (x < 0 || y < 0 || x >= w || y >= h) {
        offPage++;
        continue;
      }
      worst = Math.max(worst, away[y * w + x]);
    }

    expect(offPage, `${offPage} vertices are off the page entirely`).toBe(0);
    expect(worst, `worst vertex is ${worst.toFixed(1)}px outside the drawing`)
      .toBeLessThan(BUDGET);
  });

  it("maps the drawing onto the surface, not past its edges", () => {
    for (let v = 0; v < creature.vertices; v++) {
      expect(mesh.uv[v * 2]).toBeGreaterThanOrEqual(-0.05);
      expect(mesh.uv[v * 2]).toBeLessThanOrEqual(1.05);
      expect(mesh.uv[v * 2 + 1]).toBeGreaterThanOrEqual(-0.05);
      expect(mesh.uv[v * 2 + 1]).toBeLessThanOrEqual(1.05);
    }
  });
});
