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
    // A sixty-fourth of a stride is a small motion. A vertex crossing half a grid
    // cell in that time is a weight blow-up, not a walk.
    const LIMIT = 12;
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
        // Bounds set from what the rig actually achieves (0.27 to 1.96 at the worst
        // triangle, where the two front feet touch on the sheet), with room for a
        // gait tweak but not for a tear.
        expect(ratio, `triangle ${t / 3} inverted`).toBeGreaterThan(0);
        expect(ratio, `triangle ${t / 3} collapsed`).toBeGreaterThan(0.15);
        expect(ratio, `triangle ${t / 3} stretched`).toBeLessThan(3);
      }
    }
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
