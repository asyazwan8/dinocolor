import {
  BOX_OUTER_CANVAS_CORNERS,
  QR_CANVAS_CORNERS,
  TEXTURE,
  type Pt,
} from "@/lib/sheet/geometry";
import type { SheetCode } from "@/lib/sheet/code";
import {
  refineBoxCorners,
  type BoxDetectOptions,
  type BoxDetectResult,
} from "./boxDetect";
import {
  applyH,
  mat3Inv,
  solveHomography,
  solveSimilarity,
  type Mat3,
} from "./homography";
import { toGray, type RgbaImage } from "./image";
import { detectQr } from "./qrDetect";
import { assessQuality, type QualityMetrics } from "./quality";
import { rectify } from "./rectify";
import { autoWhiteBalance, type WhitePoint } from "./whiteBalance";

/**
 * How far, in canonical pixels, the QR may land from where the box-derived homography
 * says it should be. At 5px/mm this allows 3mm of disagreement: loose enough for
 * print tolerance and detector jitter, tight enough that a border mistaken for a
 * table edge or a neighbouring sheet is caught rather than silently rectified.
 */
const MAX_QR_DISAGREEMENT = 15;

export type CaptureFailure =
  | { kind: "no-qr" }
  | { kind: "no-box" }
  | { kind: "degenerate" }
  | { kind: "inconsistent"; disagreement: number }
  | { kind: "quality"; metrics: QualityMetrics };

export interface CaptureSuccess {
  ok: true;
  code: SheetCode;
  texture: RgbaImage;
  boxCorners: Pt[];
  /** canonical space -> image space */
  imageFromCanvas: Mat3;
  metrics: QualityMetrics;
  boxConfidence: number;
  boxEdgeConfidence: number[];
  qrDisagreement: number;
  white: WhitePoint | null;
}

export interface CaptureFailureResult {
  ok: false;
  failure: CaptureFailure;
  hint: string;
  /** Present once the sheet has been located, for drawing a live outline. */
  boxCorners?: Pt[];
  code?: SheetCode;
}

export type CaptureResult = CaptureSuccess | CaptureFailureResult;

const HINTS: Record<CaptureFailure["kind"], string> = {
  "no-qr": "Point the camera at the whole sheet",
  "no-box": "Make sure the black border is fully visible",
  degenerate: "Lay the sheet flat",
  inconsistent: "Only one sheet in shot, please",
  quality: "Hold steady",
};

function fail(failure: CaptureFailure, extra: Partial<CaptureFailureResult> = {}): CaptureFailureResult {
  return { ok: false, failure, hint: HINTS[failure.kind], ...extra };
}

export interface CaptureOptions {
  box: Partial<BoxDetectOptions>;
  /** Skip the quality gate. Used by the tuning harness on fixed test images. */
  skipQualityGate: boolean;
  tryInvertedQr: boolean;
}

/**
 * Full capture: locate the sheet, verify it, and flatten it into the canonical
 * texture the rig expects.
 *
 * The QR and the box play deliberately different roles. The QR says which sheet this
 * is and roughly where it sits; the box, spanning the whole sheet, provides the
 * geometry. They are then cross-checked against each other rather than averaged
 * together, so that a disagreement surfaces as a rejection instead of quietly
 * dragging the fit halfway between two wrong answers.
 */
export function captureFromFrame(
  frame: RgbaImage,
  options: Partial<CaptureOptions> = {},
): CaptureResult {
  const gray = toGray(frame);

  const qr = detectQr(frame, { tryInverted: options.tryInvertedQr });
  if (!qr) return fail({ kind: "no-qr" });

  // Coarse fit from the QR alone, deliberately a similarity rather than a full
  // homography: see solveSimilarity. Enough to say where to look for the border,
  // never enough to rectify from.
  const coarse = solveSimilarity(QR_CANVAS_CORNERS, qr.corners);
  if (!coarse) return fail({ kind: "degenerate" }, { code: qr.code });

  // Two passes. The first sweeps wide, because a similarity seeded from one small
  // symbol can sit a good fraction of the sheet away from the true border once the
  // photo is taken at an angle. Re-solving from those corners yields a real
  // homography, so the second pass only has to nudge each edge into place: it can
  // then search a narrow band and land sub-pixel, without being pulled off by crayon
  // or a table edge running near the border.
  /**
   * How far the detected QR lands from where a homography says it should, in
   * canonical pixels. Zero means the border fit and the QR agree perfectly.
   */
  const disagreementOf = (model: Mat3): number => {
    const canvasFromImage = mat3Inv(model);
    if (!canvasFromImage) return Infinity;
    let sum = 0;
    for (let i = 0; i < 4; i++) {
      const p = applyH(canvasFromImage, qr.corners[i]);
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return Infinity;
      sum += (p.x - QR_CANVAS_CORNERS[i].x) ** 2 + (p.y - QR_CANVAS_CORNERS[i].y) ** 2;
    }
    return Math.sqrt(sum / 4);
  };

  const attempt = (model: Mat3, fraction: number) => {
    const refined = refineBoxCorners(gray, model, {
      ...options.box,
      searchRadiusFraction: fraction,
    });
    if (!refined) return null;
    const solved = solveHomography(BOX_OUTER_CANVAS_CORNERS, refined.corners);
    return solved ? { box: refined, model: solved, score: disagreementOf(solved) } : null;
  };

  /**
   * Open with several sweep widths and keep whichever agrees best.
   *
   * There is no single good width. The similarity is anchored on the QR in one
   * corner, so its error grows with distance and depends on the angle: too narrow
   * and the far edge falls outside the band entirely, too wide and a nearby edge
   * has room to lock onto competing structure. Trying a few and scoring them
   * removes the guess - and with it the whack-a-mole of tuning one constant to suit
   * every geometry at once.
   */
  let best: { box: BoxDetectResult; model: Mat3; score: number } | null = null;
  for (const fraction of [0.2, 0.3, 0.44]) {
    const candidate = attempt(coarse, fraction);
    if (candidate && (!best || candidate.score < best.score)) best = candidate;
  }
  if (!best) return fail({ kind: "no-box" }, { code: qr.code });

  /**
   * Then narrow in steps, again keeping the best rather than the last.
   *
   * Tightening is not reliably monotonic: a narrower band is more precise when it
   * converges, but lands on noise when the previous pass left more error than the
   * band covers.
   */
  let model = best.model;
  for (const fraction of [0.12, 0.05, 0.02, 0.01]) {
    const candidate = attempt(model, fraction);
    if (!candidate) continue;
    // Always step forward, so the next band narrows around the newest estimate...
    model = candidate.model;
    // ...but only adopt it as the answer if it actually agrees better.
    if (candidate.score < best.score) best = candidate;
  }

  const box = best.box;
  const imageFromCanvas = best.model;
  const disagreement = best.score;

  /**
   * The cross-check is a selection criterion above as well as a gate here. It still
   * earns the gate: if every candidate disagrees this badly, the border found was
   * not this sheet's, and rectifying from it would put the printed frame through
   * the middle of the child's drawing.
   */
  if (disagreement > MAX_QR_DISAGREEMENT) {
    return fail(
      { kind: "inconsistent", disagreement },
      { code: qr.code, boxCorners: box.corners },
    );
  }

  const verdict = assessQuality(gray, box.corners);
  if (!verdict.ok && !options.skipQualityGate) {
    return {
      ok: false,
      failure: { kind: "quality", metrics: verdict.metrics },
      hint: verdict.hint ?? HINTS.quality,
      code: qr.code,
      boxCorners: box.corners,
    };
  }

  const warped = rectify(frame, imageFromCanvas, TEXTURE.w, TEXTURE.h);
  const { image, white } = autoWhiteBalance(warped);

  return {
    ok: true,
    code: qr.code,
    texture: image,
    boxCorners: box.corners,
    imageFromCanvas,
    metrics: verdict.metrics,
    boxConfidence: box.confidence,
    boxEdgeConfidence: box.edgeConfidence,
    qrDisagreement: disagreement,
    white,
  };
}
