import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { poseGait } from "@/world/gait";
import { Skeleton } from "@/world/skeleton";
import type { Rig, RigPart } from "@/world/types";

/**
 * Invariants of the layered rig.
 *
 * They exist because the defect they guard against - a drawing that comes apart when
 * it moves - was invisible to every check the project had. The old rig was only ever
 * rendered standing still, and standing still is the one pose that is always correct.
 * So everything here poses the animal first.
 *
 * The claims are different from the four skinned revisions that came before, because
 * the method is: nothing deforms, so the question is no longer "how far did the ink
 * stretch" but "can a cut ever be seen". Which is a question about draw order and
 * about how far each limb reaches under the body, and both are checked here.
 */

const rig: Rig = JSON.parse(
  readFileSync(resolve(__dirname, "../world/rigs/triceratops.json"), "utf8"),
);

const skeleton = new Skeleton(rig.parts);
const ids = rig.parts.map((p) => p.id);
const indexOf = (id: string) => {
  const i = skeleton.indexOf.get(id);
  expect(i, `rig has no part "${id}"`).toBeDefined();
  return i!;
};

/** One part's alpha mask, read back as a predicate in canonical texture pixels. */
function readMask(part: RigPart) {
  const png = PNG.sync.read(readFileSync(resolve(__dirname, "../public" + part.mask)));
  expect(png.width, `${part.id} mask width`).toBe(part.box.w);
  expect(png.height, `${part.id} mask height`).toBe(part.box.h);
  return (x: number, y: number): boolean => {
    const lx = Math.round(x) - part.box.x;
    const ly = Math.round(y) - part.box.y;
    if (lx < 0 || ly < 0 || lx >= png.width || ly >= png.height) return false;
    return png.data[(ly * png.width + lx) * 4 + 3] > 128;
  };
}

const masks = new Map(rig.parts.map((part) => [part.id, readMask(part)]));
const legs = rig.parts.filter((part) => part.id.startsWith("leg"));

/** Local rotations for one frame of the walk, at full pace. */
function poseAt(phase: number, speed = 1): Float32Array {
  const rotation = new Float32Array(rig.parts.length);
  poseGait(ids, skeleton.rootIndex, { phase, breath: 0 }, speed, rotation);
  return rotation;
}

const STEPS = 64;
const stride = Array.from({ length: STEPS + 1 }, (_, i) =>
  poseAt((i / STEPS) * Math.PI * 2),
);

/** The widest each part turns, relative to its parent, over a full stride. */
function widestSwing(id: string): number {
  const i = indexOf(id);
  return stride.reduce((most, frame) => Math.max(most, Math.abs(frame[i])), 0);
}

describe("the design rule", () => {
  /**
   * The rule that makes the cuts invisible, stated as a test rather than only as a
   * comment: parts are listed back to front, and every limb is painted BEFORE the
   * body, so the cut across a limb's top is under the torso at every angle. Revision 4
   * was also a cut-out rig and looked chopped up because it drew the near legs on top.
   */
  it("lists the parts back to front", () => {
    for (let i = 1; i < rig.parts.length; i++) {
      expect(rig.parts[i].z, `${rig.parts[i].id} is out of draw order`).toBeGreaterThan(
        rig.parts[i - 1].z,
      );
    }
  });

  it("draws every limb behind the body", () => {
    const body = rig.parts.find((part) => part.id === "body");
    expect(body).toBeDefined();
    for (const leg of legs) {
      expect(leg.z, `${leg.id} is drawn in front of the body`).toBeLessThan(body!.z);
      expect(leg.parent).toBe("body");
    }
  });
});

describe("parts stay rigid", () => {
  /**
   * The whole claim of this revision, and the one thing blend skinning could never
   * offer: a part is moved by a rotation and a translation and by nothing else, so
   * the distance between any two points of the drawing that belong to the same part
   * is the same in every pose. Exact, not within a tolerance.
   */
  it("keeps every distance within a part, in every pose", () => {
    const probes = rig.parts.map((part) => [
      { x: part.box.x, y: part.box.y },
      { x: part.box.x + part.box.w, y: part.box.y },
      { x: part.box.x, y: part.box.y + part.box.h },
      { x: part.box.x + part.box.w, y: part.box.y + part.box.h },
      part.pivot,
    ]);

    for (const rotation of stride) {
      const solved = skeleton.solve(rotation, 0, 0);

      rig.parts.forEach((part, i) => {
        const cos = Math.cos(solved.rot[i]);
        const sin = Math.sin(solved.rot[i]);
        const posed = probes[i].map((p) => {
          const dx = p.x - part.pivot.x;
          const dy = p.y - part.pivot.y;
          return {
            x: solved.x[i] + dx * cos - dy * sin,
            y: solved.y[i] + dx * sin + dy * cos,
          };
        });

        for (let a = 0; a < posed.length; a++) {
          for (let b = a + 1; b < posed.length; b++) {
            const rest = Math.hypot(
              probes[i][a].x - probes[i][b].x,
              probes[i][a].y - probes[i][b].y,
            );
            const now = Math.hypot(posed[a].x - posed[b].x, posed[a].y - posed[b].y);
            expect(now, `${part.id} changed shape`).toBeCloseTo(rest, 6);
          }
        }
      });
    }
  });
});

describe("the hip cannot open", () => {
  /**
   * A limb is cut off at the belly, so the moment it swings, the top of that cut
   * leaves the place the belly line left it. What stops bare paper showing through is
   * the material buried above the cut, inside the torso, and the question is whether
   * there is enough of it at the ENDS of the swing rather than at rest.
   *
   * What is checked here is a floor, not a proof: at the extremes of its swing each
   * limb must still have more of itself inside the torso than its top edge is able to
   * sweep out of it. A rig built without burial, or with a limb cut flush at the
   * belly, cannot clear that; a rig that clears it can still, in principle, open a
   * wedge somewhere. The decisive check is the posed strip that
   * `scripts/previewRig.mts` renders - a cut either shows there or it does not, and
   * four revisions failed exactly there while passing everything automated.
   */
  const body = masks.get("body")!;

  for (const leg of legs) {
    it(`keeps ${leg.id} inside the body at both ends of its swing`, () => {
      const limb = masks.get(leg.id)!;
      const swing = widestSwing(leg.id);
      expect(swing, `${leg.id} never moves`).toBeGreaterThan(0.2);

      // How far the limb reaches to either side of its own joint where it comes out
      // from under the belly, and so how far its top edge can dip below the line.
      let reach = 0;
      for (let x = leg.box.x; x < leg.box.x + leg.box.w; x++) {
        let lowest = -1;
        for (let y = 0; y < rig.texture.h; y++) if (body(x, y)) lowest = y;
        if (lowest < 0 || !limb(x, lowest + 1)) continue;
        reach = Math.max(reach, Math.abs(x - leg.pivot.x));
      }
      expect(reach, `${leg.id} never meets the belly`).toBeGreaterThan(20);
      const swept = reach * Math.sin(swing) * reach;

      for (const angle of [-swing, swing]) {
        const cos = Math.cos(-angle);
        const sin = Math.sin(-angle);
        let inside = 0;
        for (let y = 0; y < rig.texture.h; y++) {
          for (let x = 0; x < rig.texture.w; x++) {
            if (!body(x, y)) continue;
            const dx = x - leg.pivot.x;
            const dy = y - leg.pivot.y;
            if (limb(leg.pivot.x + dx * cos - dy * sin, leg.pivot.y + dx * sin + dy * cos))
              inside++;
          }
        }
        expect(
          inside,
          `${leg.id} has only ${inside}px left inside the body at ` +
            `${angle.toFixed(2)} rad, against ${Math.round(swept)}px it can sweep out`,
        ).toBeGreaterThan(swept);
      }
    });
  }
});

describe("the walk cycle", () => {
  /**
   * Sampled finely enough that a real jump cannot hide between two samples, and run
   * forward rather than wrapped: the head deliberately swings at a fraction of the leg
   * cadence, so the walk never actually repeats. Comparing the last sample against the
   * first would flag that as a jump, which is a property of the gait, not a defect.
   */
  const placements = stride.map((rotation) => {
    const solved = skeleton.solve(rotation, 0, 0);
    return rig.parts.map((_, i) => ({
      x: solved.x[i],
      y: solved.y[i],
      rot: solved.rot[i],
    }));
  });

  it("stays finite everywhere", () => {
    for (const frame of placements) {
      for (const at of frame) {
        expect(Number.isFinite(at.x) && Number.isFinite(at.y) && Number.isFinite(at.rot))
          .toBe(true);
      }
    }
  });

  it("never jumps a part between adjacent frames", () => {
    // A sixty-fourth of a stride is a small motion; a part crossing several pixels of
    // the drawing in that time is a gait blow-up, not a walk.
    const LIMIT = 0.06;
    for (let f = 0; f < placements.length - 1; f++) {
      rig.parts.forEach((part, i) => {
        const a = placements[f][i];
        const b = placements[f + 1][i];
        expect(
          Math.abs(a.rot - b.rot),
          `${part.id} jumped between frames ${f} and ${f + 1}`,
        ).toBeLessThan(LIMIT);
      });
    }
  });

  it("swings the diagonal pairs together and the others apart", () => {
    // A diagonal gait, which is what a heavy quadruped walks: near front with far
    // rear. Pairing them the other way reads as a pantomime horse, and the rig had it
    // that way for four revisions because the near and far legs were labelled from
    // guesswork rather than from the drawing.
    const at = poseAt(1.1);
    const swing = (id: string) => at[indexOf(id)];

    expect(Math.sign(swing("legFrontNear"))).toBe(Math.sign(swing("legRearFar")));
    expect(Math.sign(swing("legFrontFar"))).toBe(Math.sign(swing("legRearNear")));
    expect(Math.sign(swing("legFrontNear"))).not.toBe(Math.sign(swing("legFrontFar")));
  });

  it("stands still when it is not walking", () => {
    const still = poseAt(2.3, 0);
    for (const leg of legs) expect(still[indexOf(leg.id)] === 0).toBe(true);
  });
});

describe("skeleton", () => {
  it("solves parents before children", () => {
    // A child solved before its parent silently inherits last frame's transform, which
    // reads as a limb lagging by one frame - subtle enough to live for a long time.
    const rotation = new Float32Array(rig.parts.length);
    rotation[skeleton.rootIndex] = 0.3;
    const solved = skeleton.solve(rotation, 0, 0);

    for (let i = 0; i < rig.parts.length; i++) {
      if (i === skeleton.rootIndex) continue;
      const part = rig.parts[i];
      const parent = rig.parts[indexOf(part.parent!)];
      const ox = part.pivot.x - parent.pivot.x;
      const oy = part.pivot.y - parent.pivot.y;
      const c = Math.cos(0.3);
      const s = Math.sin(0.3);
      expect(solved.x[i]).toBeCloseTo(ox * c - oy * s, 2);
      expect(solved.y[i]).toBeCloseTo(ox * s + oy * c, 2);
    }
  });

  it("refuses a skeleton whose parts parent each other in a cycle", () => {
    expect(
      () =>
        new Skeleton([
          { id: "a", parent: "b", pivot: { x: 0, y: 0 } },
          { id: "b", parent: "a", pivot: { x: 1, y: 1 } },
        ]),
    ).toThrow(/root/);
  });
});
