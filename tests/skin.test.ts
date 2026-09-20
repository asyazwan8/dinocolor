import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { poseGait } from "@/world/gait";
import { Skeleton, skinMesh } from "@/world/skin";
import type { Rig } from "@/world/types";

/**
 * Invariants of the skinned rig.
 *
 * These exist because the defect they guard against - a drawing that comes apart when
 * it moves - was invisible to every check the project had. The old rig was only ever
 * rendered standing still, and standing still is the one pose that is always correct.
 * So everything here poses the animal first.
 */

const rig: Rig = JSON.parse(
  readFileSync(resolve(__dirname, "../world/rigs/triceratops.json"), "utf8"),
);

const skeleton = new Skeleton(rig.bones);
const ids = rig.bones.map((b) => b.id);
const { vertexCount, influences, positions, boneIndex, boneWeight } = rig.mesh;

function poseAt(phase: number, speed = 1): Float32Array {
  const rotation = new Float32Array(rig.bones.length);
  const bob = poseGait(ids, skeleton.rootIndex, { phase, breath: 0 }, speed, rotation);
  const out = new Float32Array(vertexCount * 2);
  skinMesh(rig.mesh, skeleton.solve(rotation, 0, bob), out);
  return out;
}

/** Skin with one bone rotated and everything else at rest. */
function poseBone(id: string, angle: number): Float32Array {
  const rotation = new Float32Array(rig.bones.length);
  const index = skeleton.indexOf.get(id);
  expect(index, `rig has no bone "${id}"`).toBeDefined();
  rotation[index!] = angle;
  const out = new Float32Array(vertexCount * 2);
  skinMesh(rig.mesh, skeleton.solve(rotation, 0, 0), out);
  return out;
}

const root = rig.bones[skeleton.rootIndex].pivot;

describe("weights", () => {
  it("sum to one on every vertex, with no NaN and at least one real influence", () => {
    for (let v = 0; v < vertexCount; v++) {
      let sum = 0;
      let real = 0;
      for (let i = 0; i < influences; i++) {
        const w = boneWeight[v * influences + i];
        const b = boneIndex[v * influences + i];
        expect(Number.isFinite(w), `vertex ${v} influence ${i} weight`).toBe(true);
        expect(w).toBeGreaterThanOrEqual(0);
        expect(b, `vertex ${v} influence ${i} bone index`).toBeGreaterThanOrEqual(0);
        expect(b).toBeLessThan(rig.bones.length);
        sum += w;
        if (w > 0) real++;
      }
      expect(sum, `vertex ${v} weights`).toBeCloseTo(1, 4);
      expect(real, `vertex ${v} has no influence`).toBeGreaterThan(0);
    }
  });
});

describe("rest pose", () => {
  it("reproduces the drawing exactly when no bone is rotated", () => {
    const out = poseBone(ids[skeleton.rootIndex], 0);
    for (let v = 0; v < vertexCount; v++) {
      // Skinning works relative to the root pivot, which is what the world positions
      // the dinosaur from. Any drift here would show as the whole animal sliding.
      //
      // A hundredth of a pixel, not exactly: rest offsets and rest positions are each
      // rounded to two places on the way into the rig, so reconstructing one from the
      // other cannot be exact. It only has to be far below anything visible.
      expect(Math.abs(out[v * 2] - (positions[v * 2] - root.x))).toBeLessThan(0.02);
      expect(Math.abs(out[v * 2 + 1] - (positions[v * 2 + 1] - root.y))).toBeLessThan(0.02);
    }
  });
});

describe("bone isolation", () => {
  it("moves a leg's own vertices and leaves the far end of the body put", () => {
    const out = poseBone("legFrontNear", 0.5);

    const hip = rig.bones.find((b) => b.id === "legFrontNear")!.pivot;
    const legIndex = skeleton.indexOf.get("legFrontNear")!;

    let movedInLeg = 0;
    let maxTailDrift = 0;

    for (let v = 0; v < vertexCount; v++) {
      const dx = out[v * 2] - (positions[v * 2] - root.x);
      const dy = out[v * 2 + 1] - (positions[v * 2 + 1] - root.y);
      const moved = Math.hypot(dx, dy);

      // Vertices the leg leads, well below the hip, must swing. "Leads" rather than
      // "owns outright": the blend that keeps the hips smooth means no vertex on a
      // limb this close to its neighbour is ever bound to one bone alone.
      const leads =
        boneIndex[v * influences] === legIndex && boneWeight[v * influences] > 0.5;
      if (leads && positions[v * 2 + 1] > hip.y + 80) {
        movedInLeg++;
        expect(moved, `leading leg vertex ${v} did not move`).toBeGreaterThan(5);
      }

      // The tail is on the other side of the body and hangs off a different bone.
      // If it twitches when a front leg lifts, the weights have smeared body-wide.
      if (positions[v * 2] < rig.bones.find((b) => b.id === "tail")!.pivot.x - 120) {
        maxTailDrift = Math.max(maxTailDrift, moved);
      }
    }

    expect(movedInLeg, "no vertex is owned by the front near leg").toBeGreaterThan(5);
    expect(maxTailDrift, "the tail moved when a front leg lifted").toBeLessThan(1);
  });
});

describe("the walk cycle", () => {
  /**
   * Sampled finely enough that a real tear cannot hide between two samples, and run
   * forward rather than wrapped: the tail and head deliberately swing at fractions of
   * the leg cadence, so the walk never actually repeats. Comparing the last sample
   * against the first would flag that as a jump, which is a property of the gait, not
   * a defect in it.
   */
  const STEPS = 64;
  const frames = Array.from({ length: STEPS + 1 }, (_, i) =>
    poseAt((i / STEPS) * Math.PI * 2),
  );

  it("stays finite everywhere", () => {
    for (const frame of frames) {
      for (let i = 0; i < frame.length; i++) {
        expect(Number.isFinite(frame[i])).toBe(true);
      }
    }
  });

  it("never jumps a vertex between adjacent frames", () => {
    // A sixty-fourth of a stride is a small motion. A vertex crossing most of a grid
    // cell in that time is a weight blow-up, not a walk. The rig reaches 12.3px, which
    // is a rigid foot at the end of its lever doing exactly what it should.
    const LIMIT = 20;
    for (let f = 0; f < frames.length - 1; f++) {
      const a = frames[f];
      const b = frames[f + 1];
      for (let v = 0; v < vertexCount; v++) {
        const step = Math.hypot(a[v * 2] - b[v * 2], a[v * 2 + 1] - b[v * 2 + 1]);
        expect(step, `vertex ${v} jumped between frames ${f} and ${f + 1}`).toBeLessThan(
          LIMIT,
        );
      }
    }
  });

  it("never tears or folds a triangle", () => {
    /**
     * This is the invariant the old cutout rig could not have satisfied at any price.
     * A part sliding out from behind another shows up as triangles stretching without
     * bound along the cut; a fold shows up as one flipping over. Neither is allowed.
     */
    const { indices } = rig.mesh;

    const area = (p: ArrayLike<number>, t: number) => {
      const a = indices[t] * 2;
      const b = indices[t + 1] * 2;
      const c = indices[t + 2] * 2;
      return (
        ((p[b] - p[a]) * (p[c + 1] - p[a + 1]) - (p[c] - p[a]) * (p[b + 1] - p[a + 1])) / 2
      );
    };

    const rest = new Float32Array(positions.length);
    for (let i = 0; i < positions.length; i += 2) {
      rest[i] = positions[i] - root.x;
      rest[i + 1] = positions[i + 1] - root.y;
    }

    for (const frame of frames) {
      for (let t = 0; t < indices.length; t += 3) {
        const r = area(rest, t);
        if (Math.abs(r) < 1e-6) continue;
        const ratio = area(frame, t) / r;
        // Bounds set from what the rig actually achieves (0.69 to 1.32), with room for
        // a gait tweak but not for a tear. Before the limbs were separated on the sheet
        // this reached -3.8, and before they were given haunches, 0.26.
        expect(ratio, `triangle ${t / 3} inverted`).toBeGreaterThan(0);
        expect(ratio, `triangle ${t / 3} collapsed`).toBeGreaterThan(0.45);
        expect(ratio, `triangle ${t / 3} stretched`).toBeLessThan(2);
      }
    }
  });
});

describe("limbs stay rigid", () => {
  /**
   * The two invariants that say, in numbers, that a leg swings instead of warping.
   *
   * Both failed on the rig that shipped before the sheet was redrawn, and the second
   * is the one that matters: a leg vertex that carries 0.47 of a leg swinging the
   * OTHER way is pulled two directions at once, and the limb bulges and bends through
   * the stride. It is the defect the whole change exists to remove, and nothing else
   * in this file could see it.
   */
  const isLeg = (index: number) => rig.bones[index].id.startsWith("leg");

  it("gives a leg vertex almost no weight from any other leg", () => {
    let worst = 0;
    let at = -1;
    for (let v = 0; v < vertexCount; v++) {
      const own = boneIndex[v * influences];
      if (!isLeg(own)) continue;
      for (let i = 1; i < influences; i++) {
        const other = boneIndex[v * influences + i];
        if (!isLeg(other) || other === own) continue;
        if (boneWeight[v * influences + i] > worst) {
          worst = boneWeight[v * influences + i];
          at = v;
        }
      }
    }
    // Structurally zero: the build hands any second limb's share to the body, because
    // two limbs in opposite phase pull a shared vertex two ways at once. It was 0.47
    // when the legs touched on the sheet.
    expect(worst, `vertex ${at} is shared between two legs`).toBeLessThan(0.001);
  });

  it("keeps the hip still while the limb swings", () => {
    /**
     * The one that says the leg is a whole limb turning about its hip.
     *
     * The contour where a limb meets the body is drawn as a circular arc centred on
     * its pivot, and a circle turned about its own centre maps onto itself - so ink
     * at the joint slides ALONG its own curve and never across it. The test is
     * therefore not "does the hip move" (it moves 42px, tangentially, as it should)
     * but "does it move off its own contour", which is the distance from the pivot.
     *
     * Linear blend skinning lands on the chord rather than the arc, so a couple of
     * millimetres of radial contraction is its due and the bound allows it. What the
     * bound refuses is the previous sheet's straight-topped limb, whose corners swung
     * 38px clean across the belly line and tore the hip open.
     */
    const rotation = new Float32Array(rig.bones.length);
    const out = new Float32Array(vertexCount * 2);
    let worst = 0;
    let at = -1;

    for (let b = 0; b < rig.bones.length; b++) {
      if (!isLeg(b)) continue;
      rotation.fill(0);
      rotation[b] = 0.4; // the gait's full swing
      skinMesh(rig.mesh, skeleton.solve(rotation, 0, 0), out);
      const pivot = rig.bones[b].pivot;

      for (let v = 0; v < vertexCount; v++) {
        let held = 0;
        for (let i = 0; i < influences; i++) {
          if (boneIndex[v * influences + i] === b) held = boneWeight[v * influences + i];
        }
        if (held < 0.2) continue;

        const before = Math.hypot(positions[v * 2] - pivot.x, positions[v * 2 + 1] - pivot.y);
        if (before > 110) continue; // the joint region, not the far end of the limb
        const after = Math.hypot(
          out[v * 2] + root.x - pivot.x,
          out[v * 2 + 1] + root.y - pivot.y,
        );
        if (Math.abs(after - before) > worst) {
          worst = Math.abs(after - before);
          at = v;
        }
      }
    }

    expect(at, "no vertex sits in a joint region").toBeGreaterThan(-1);
    // The rig reaches 1.7px.
    expect(worst, `vertex ${at} at a hip moved across its own contour`).toBeLessThan(3);
  });

  it("binds the lower half of a limb to that limb alone", () => {
    let weakest = 1;
    let at = -1;
    for (let v = 0; v < vertexCount; v++) {
      const own = boneIndex[v * influences];
      if (!isLeg(own)) continue;
      // Well below the hip, where there is no joint and nothing to blend with.
      if (positions[v * 2 + 1] - rig.bones[own].pivot.y <= 120) continue;
      if (boneWeight[v * influences] < weakest) {
        weakest = boneWeight[v * influences];
        at = v;
      }
    }
    expect(at, "no leg vertex sits far enough below a hip to test").toBeGreaterThan(-1);
    // The rig reaches 0.98 at its weakest.
    expect(weakest, `vertex ${at} in mid-limb is not bound to its own bone`).toBeGreaterThan(
      0.9,
    );
  });
});

describe("skeleton", () => {
  it("solves parents before children", () => {
    // A child solved before its parent silently inherits last frame's transform, which
    // reads as a limb lagging by one frame - subtle enough to live for a long time.
    const rotation = new Float32Array(rig.bones.length);
    rotation[skeleton.rootIndex] = 0.3;
    const solved = skeleton.solve(rotation, 0, 0);

    for (let i = 0; i < rig.bones.length; i++) {
      if (i === skeleton.rootIndex) continue;
      const bone = rig.bones[i];
      const parent = rig.bones[skeleton.indexOf.get(bone.parent!)!];
      const ox = bone.pivot.x - parent.pivot.x;
      const oy = bone.pivot.y - parent.pivot.y;
      const c = Math.cos(0.3);
      const s = Math.sin(0.3);
      expect(solved.x[i]).toBeCloseTo(ox * c - oy * s, 2);
      expect(solved.y[i]).toBeCloseTo(ox * s + oy * c, 2);
    }
  });

  it("refuses a skeleton whose bones parent each other in a cycle", () => {
    expect(
      () =>
        new Skeleton([
          { id: "a", parent: "b", pivot: { x: 0, y: 0 } },
          { id: "b", parent: "a", pivot: { x: 1, y: 1 } },
        ]),
    ).toThrow(/root/);
  });
});
