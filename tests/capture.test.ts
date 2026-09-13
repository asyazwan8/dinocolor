import { describe, expect, it } from "vitest";
import {
  BOX_INNER_MM,
  BOX_OUTER_MM,
  PX_PER_MM,
  QR_CANVAS_CORNERS,
  TEXTURE,
  type Pt,
} from "@/lib/sheet/geometry";
import { applyH, mat3Inv, solveHomography, type Mat3 } from "@/lib/vision/homography";
import type { RgbaImage } from "@/lib/vision/image";
import { captureFromFrame } from "@/lib/vision/pipeline";
import { rectify } from "@/lib/vision/rectify";
import {
  DEFAULT_PHOTO,
  PAGE_CORNERS,
  degrade,
  photoQuad,
  renderSheet,
  truthImageFromCanvas,
  type PhotoOptions,
} from "./helpers/syntheticSheet";

/** Photograph a rendered sheet under the given conditions. */
async function shoot(overrides: Partial<PhotoOptions> = {}) {
  const options: PhotoOptions = { ...DEFAULT_PHOTO, width: 1600, height: 1200, ...overrides };
  const { page, payload } = await renderSheet();

  const photoFromPage = solveHomography(PAGE_CORNERS, photoQuad(options));
  if (!photoFromPage) throw new Error("bad test camera");
  const pageFromPhoto = mat3Inv(photoFromPage);
  if (!pageFromPhoto) throw new Error("bad test camera");

  const clean = rectify(page, pageFromPhoto, options.width, options.height);
  return {
    photo: degrade(clean, options),
    page,
    payload,
    photoFromPage,
    truth: truthImageFromCanvas(photoFromPage),
  };
}

const mm = (v: number) => v * PX_PER_MM;
const BOX_OUTER_PAGE: Pt[] = [
  { x: mm(BOX_OUTER_MM.x), y: mm(BOX_OUTER_MM.y) },
  { x: mm(BOX_OUTER_MM.x + BOX_OUTER_MM.w), y: mm(BOX_OUTER_MM.y) },
  { x: mm(BOX_OUTER_MM.x + BOX_OUTER_MM.w), y: mm(BOX_OUTER_MM.y + BOX_OUTER_MM.h) },
  { x: mm(BOX_OUTER_MM.x), y: mm(BOX_OUTER_MM.y + BOX_OUTER_MM.h) },
];

/** Worst canonical-space error when mapping through the recovered homography. */
function canonicalError(recovered: Mat3, truth: Mat3): number {
  const probes: Pt[] = [
    { x: 0, y: 0 },
    { x: TEXTURE.w, y: 0 },
    { x: TEXTURE.w, y: TEXTURE.h },
    { x: 0, y: TEXTURE.h },
    { x: TEXTURE.w / 2, y: TEXTURE.h / 2 },
    ...QR_CANVAS_CORNERS,
  ];
  let worst = 0;
  for (const p of probes) {
    const a = applyH(recovered, p);
    const b = applyH(truth, p);
    worst = Math.max(worst, Math.hypot(a.x - b.x, a.y - b.y));
  }
  return worst;
}

/** The canonical region of the original sheet, for comparing against the capture. */
function referenceTexture(page: RgbaImage): RgbaImage {
  const identityFromCanvas: Mat3 = [
    1, 0, mm(BOX_INNER_MM.x),
    0, 1, mm(BOX_INNER_MM.y),
    0, 0, 1,
  ];
  return rectify(page, identityFromCanvas, TEXTURE.w, TEXTURE.h);
}

function meanAbsDiff(a: RgbaImage, b: RgbaImage, step = 7): number {
  let sum = 0;
  let n = 0;
  for (let y = 0; y < a.height; y += step) {
    for (let x = 0; x < a.width; x += step) {
      const o = (y * a.width + x) * 4;
      sum += Math.abs(a.data[o] - b.data[o]);
      sum += Math.abs(a.data[o + 1] - b.data[o + 1]);
      sum += Math.abs(a.data[o + 2] - b.data[o + 2]);
      n += 3;
    }
  }
  return sum / n;
}

describe("capture pipeline, square-on", () => {
  it("reads the sheet and flattens it to the canonical texture", async () => {
    const { photo, page, truth } = await shoot();
    const result = captureFromFrame(photo);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.code).toEqual({ version: "DC1", dino: "TRI", serial: "0042" });
    expect(result.texture.width).toBe(TEXTURE.w);
    expect(result.texture.height).toBe(TEXTURE.h);

    // Sub-pixel agreement with ground truth across the whole sheet.
    expect(canonicalError(result.imageFromCanvas, truth)).toBeLessThan(2);
    expect(result.boxConfidence).toBeGreaterThan(0.9);
    expect(result.qrDisagreement).toBeLessThan(4);

    expect(meanAbsDiff(result.texture, referenceTexture(page))).toBeLessThan(14);
  });

  it("locates the printed border within a fraction of a millimetre", async () => {
    const { photo, photoFromPage } = await shoot();
    const result = captureFromFrame(photo);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const expected = BOX_OUTER_PAGE.map((p) => applyH(photoFromPage, p));
    for (let i = 0; i < 4; i++) {
      const d = Math.hypot(
        result.boxCorners[i].x - expected[i].x,
        result.boxCorners[i].y - expected[i].y,
      );
      expect(d).toBeLessThan(2.5);
    }
  });
});

describe("capture pipeline, hostile conditions", () => {
  it("survives a steep hand-held angle", async () => {
    const { photo, truth } = await shoot({
      warp: [[110, 54], [-64, -28], [-92, 36], [78, -18]],
    });
    const result = captureFromFrame(photo);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(canonicalError(result.imageFromCanvas, truth)).toBeLessThan(4);
  });

  it("survives warm indoor light, blur and sensor noise together", async () => {
    const { photo, truth } = await shoot({
      warp: [[46, 22], [-30, -14], [-38, 18], [34, -8]],
      cast: [1.12, 1.0, 0.74],
      brightness: 0.82,
      blur: 1,
      noise: 14,
    });
    const result = captureFromFrame(photo);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(canonicalError(result.imageFromCanvas, truth)).toBeLessThan(5);
  });

  it("corrects a warm cast back towards neutral paper", async () => {
    const { photo } = await shoot({ cast: [1.15, 1.0, 0.7], brightness: 0.85 });
    const result = captureFromFrame(photo);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Sample the quiet zone in the corrected texture; paper should read near-grey.
    const x = QR_CANVAS_CORNERS[0].x - 10;
    const y = QR_CANVAS_CORNERS[0].y - 10;
    const o = (y * result.texture.width + x) * 4;
    const [r, g, b] = [result.texture.data[o], result.texture.data[o + 1], result.texture.data[o + 2]];

    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(18);
    expect(r).toBeGreaterThan(200);
  });
});

describe("capture pipeline, refusals", () => {
  it("refuses a frame with no sheet in it", () => {
    const blank: RgbaImage = {
      data: new Uint8ClampedArray(640 * 480 * 4).fill(255),
      width: 640,
      height: 480,
    };
    const result = captureFromFrame(blank);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("no-qr");
    expect(result.hint).toBeTruthy();
  });

  it("refuses a sheet held too far away", async () => {
    // A small sheet in a big frame: the QR still reads, the border still fits, but
    // there are too few pixels per millimetre to make a usable texture.
    const { photo } = await shoot({ width: 2400, height: 1800 });
    const cropped: RgbaImage = {
      data: new Uint8ClampedArray(2400 * 1800 * 4).fill(255),
      width: 2400,
      height: 1800,
    };
    // Paste the photo scaled into a corner to shrink its coverage.
    for (let y = 0; y < 1800; y += 1) {
      for (let x = 0; x < 2400; x += 1) {
        const sx = Math.floor(x * 3);
        const sy = Math.floor(y * 3);
        if (sx >= photo.width || sy >= photo.height) continue;
        const src = (sy * photo.width + sx) * 4;
        const dst = (y * 2400 + x) * 4;
        cropped.data[dst] = photo.data[src];
        cropped.data[dst + 1] = photo.data[src + 1];
        cropped.data[dst + 2] = photo.data[src + 2];
      }
    }
    const result = captureFromFrame(cropped);
    expect(result.ok).toBe(false);
  });
});
