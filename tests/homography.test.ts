import { describe, expect, it } from "vitest";
import { BOX_INNER_CANVAS_CORNERS, type Pt } from "@/lib/sheet/geometry";
import { BOX_OUTER_CANVAS_CORNERS, QR_CANVAS_CORNERS } from "@/lib/sheet/geometry";
import {
  IDENTITY,
  type Mat3,
  applyH,
  mat3Inv,
  mat3Mul,
  orderCorners,
  reprojectionRms,
  solveHomography,
  solveSimilarity,
} from "@/lib/vision/homography";

/** A plausible hand-held phone view: rotation, scale, translation and real keystone. */
const CAMERA: Mat3 = [1.18, 0.21, 137, -0.09, 1.07, 88, 0.00031, 0.00017, 1];

const project = (m: Mat3, pts: Pt[]) => pts.map((p) => applyH(m, p));

describe("matrix helpers", () => {
  it("multiplies by identity without change", () => {
    expect(mat3Mul(CAMERA, IDENTITY)).toEqual(CAMERA);
  });

  it("inverts, and composing with the inverse gives identity", () => {
    const inv = mat3Inv(CAMERA);
    expect(inv).not.toBeNull();
    const product = mat3Mul(CAMERA, inv as Mat3);
    const scaled = product.map((v) => v / product[8]);
    for (let i = 0; i < 9; i++) expect(scaled[i]).toBeCloseTo(IDENTITY[i], 9);
  });

  it("refuses to invert a singular matrix", () => {
    expect(mat3Inv([1, 2, 3, 2, 4, 6, 7, 8, 9])).toBeNull();
  });
});

describe("solveHomography", () => {
  it("recovers a known perspective warp from four corners", () => {
    const observed = project(CAMERA, BOX_INNER_CANVAS_CORNERS);
    const solved = solveHomography(BOX_INNER_CANVAS_CORNERS, observed);

    expect(solved).not.toBeNull();
    expect(reprojectionRms(solved as Mat3, BOX_INNER_CANVAS_CORNERS, observed)).toBeLessThan(1e-6);
  });

  it("maps interior points correctly, not just the fitted corners", () => {
    const observed = project(CAMERA, BOX_INNER_CANVAS_CORNERS);
    const solved = solveHomography(BOX_INNER_CANVAS_CORNERS, observed) as Mat3;

    // The QR corner is the point we actually rely on downstream.
    for (const probe of [{ x: 1040, y: 640 }, { x: 600, y: 400 }, { x: 1160, y: 760 }]) {
      const expected = applyH(CAMERA, probe);
      const actual = applyH(solved, probe);
      expect(actual.x).toBeCloseTo(expected.x, 6);
      expect(actual.y).toBeCloseTo(expected.y, 6);
    }
  });

  it("absorbs extra correspondences as least squares", () => {
    const src = [...BOX_INNER_CANVAS_CORNERS, { x: 1040, y: 640 }, { x: 1160, y: 760 }];
    const solved = solveHomography(src, project(CAMERA, src));

    expect(solved).not.toBeNull();
    expect(reprojectionRms(solved as Mat3, src, project(CAMERA, src))).toBeLessThan(1e-6);
  });

  it("stays accurate when detected corners carry sub-pixel noise", () => {
    const noise = [
      { x: 0.4, y: -0.3 },
      { x: -0.2, y: 0.45 },
      { x: 0.35, y: 0.2 },
      { x: -0.4, y: -0.25 },
    ];
    const observed = project(CAMERA, BOX_INNER_CANVAS_CORNERS).map((p, i) => ({
      x: p.x + noise[i].x,
      y: p.y + noise[i].y,
    }));

    const solved = solveHomography(BOX_INNER_CANVAS_CORNERS, observed) as Mat3;
    const truth = applyH(CAMERA, { x: 600, y: 400 });
    const actual = applyH(solved, { x: 600, y: 400 });

    // Half a pixel of corner noise must not blow up in the middle of the sheet.
    expect(Math.hypot(actual.x - truth.x, actual.y - truth.y)).toBeLessThan(2);
  });

  it("rejects fewer than four correspondences", () => {
    const src = BOX_INNER_CANVAS_CORNERS.slice(0, 3);
    expect(solveHomography(src, project(CAMERA, src))).toBeNull();
  });

  it("rejects mismatched input lengths", () => {
    expect(solveHomography(BOX_INNER_CANVAS_CORNERS, [{ x: 0, y: 0 }])).toBeNull();
  });

  it("rejects collinear points rather than returning a garbage matrix", () => {
    const collinear = [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 20, y: 20 },
      { x: 30, y: 30 },
    ];
    expect(solveHomography(collinear, collinear)).toBeNull();
  });

  it("rejects non-finite input", () => {
    const bad = [...BOX_INNER_CANVAS_CORNERS.slice(0, 3), { x: NaN, y: 0 }];
    expect(solveHomography(bad, bad)).toBeNull();
  });
});

describe("orderCorners", () => {
  it("sorts a shuffled quad into TL, TR, BR, BL", () => {
    const quad: Pt[] = [
      { x: 10, y: 10 },
      { x: 110, y: 20 },
      { x: 100, y: 90 },
      { x: 5, y: 80 },
    ];
    for (const rotation of [0, 1, 2, 3]) {
      const shuffled = [...quad.slice(rotation), ...quad.slice(0, rotation)];
      expect(orderCorners(shuffled)).toEqual(quad);
    }
  });

  it("survives the sheet being photographed under rotation", () => {
    const observed = project(CAMERA, BOX_INNER_CANVAS_CORNERS);
    const ordered = orderCorners([observed[2], observed[0], observed[3], observed[1]]);
    expect(ordered).toEqual(observed);
  });

  it("rejects anything that is not four points", () => {
    expect(orderCorners([{ x: 0, y: 0 }])).toBeNull();
  });
});

describe("solveSimilarity", () => {
  /** Rotate 12 degrees, scale 3.4x, translate. No perspective. */
  const angle = (12 * Math.PI) / 180;
  const scale = 3.4;
  const SIMILARITY: Mat3 = [
    scale * Math.cos(angle), -scale * Math.sin(angle), 220,
    scale * Math.sin(angle), scale * Math.cos(angle), 140,
    0, 0, 1,
  ];

  it("recovers a rotation, scale and translation exactly", () => {
    const observed = project(SIMILARITY, QR_CANVAS_CORNERS);
    const solved = solveSimilarity(QR_CANVAS_CORNERS, observed);

    expect(solved).not.toBeNull();
    for (let i = 0; i < 9; i++) {
      expect((solved as Mat3)[i]).toBeCloseTo(SIMILARITY[i], 6);
    }
  });

  it("never produces perspective terms", () => {
    const wonky = [
      { x: 0, y: 0 }, { x: 100, y: 4 }, { x: 96, y: 120 }, { x: -6, y: 110 },
    ];
    const solved = solveSimilarity(QR_CANVAS_CORNERS, wonky) as Mat3;
    expect(solved[6]).toBe(0);
    expect(solved[7]).toBe(0);
    expect(solved[8]).toBe(1);
  });

  it("rejects fewer than two correspondences", () => {
    expect(solveSimilarity([{ x: 0, y: 0 }], [{ x: 1, y: 1 }])).toBeNull();
  });

  /**
   * The reason the coarse fit is a similarity and not a homography.
   *
   * The QR spans about a tenth of the sheet. Sub-pixel noise on four corners that
   * close together cannot meaningfully constrain a homography's perspective terms,
   * so the solver absorbs the noise into a spurious keystone that then blows up
   * non-linearly with distance. Measured on the real sheet this put far corners
   * hundreds of pixels out, which is what broke box detection until the coarse
   * model was constrained.
   */
  it("extrapolates far beyond the fitted points far better than a homography", () => {
    const clean = project(SIMILARITY, QR_CANVAS_CORNERS);
    const jitter = [
      { x: 0.5, y: -0.4 }, { x: -0.45, y: 0.5 }, { x: 0.4, y: 0.45 }, { x: -0.5, y: -0.35 },
    ];
    const noisy = clean.map((p, i) => ({ x: p.x + jitter[i].x, y: p.y + jitter[i].y }));

    const asHomography = solveHomography(QR_CANVAS_CORNERS, noisy) as Mat3;
    const asSimilarity = solveSimilarity(QR_CANVAS_CORNERS, noisy) as Mat3;

    const worst = (m: Mat3) =>
      Math.max(
        ...BOX_OUTER_CANVAS_CORNERS.map((corner) => {
          const got = applyH(m, corner);
          const want = applyH(SIMILARITY, corner);
          return Math.hypot(got.x - want.x, got.y - want.y);
        }),
      );

    expect(worst(asSimilarity)).toBeLessThan(12);
    expect(worst(asHomography)).toBeGreaterThan(worst(asSimilarity) * 3);
  });
});
