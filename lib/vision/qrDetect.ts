import jsQR from "jsqr";
import { parseSheetCode, type SheetCode } from "@/lib/sheet/code";
import type { Pt } from "@/lib/sheet/geometry";
import { orderCorners } from "./homography";
import type { RgbaImage } from "./image";

export interface QrHit {
  code: SheetCode;
  /** Symbol corners in image space, ordered TL, TR, BR, BL. */
  corners: Pt[];
  raw: string;
}

export interface QrDetectOptions {
  /**
   * Our codes are always dark on light paper, so trying the inverted image doubles
   * the work for nothing in the live preview loop. Worth enabling for a one-shot
   * retry when a user insists a sheet will not scan.
   */
  tryInverted: boolean;
}

/**
 * jsQR is used rather than the native BarcodeDetector as the baseline because it
 * returns the symbol's four corner points, which is what seeds the homography.
 * Native detection is a preview-loop optimisation, not a replacement.
 */
export function detectQr(img: RgbaImage, options: Partial<QrDetectOptions> = {}): QrHit | null {
  const result = jsQR(img.data, img.width, img.height, {
    inversionAttempts: options.tryInverted ? "attemptBoth" : "dontInvert",
  });
  if (!result) return null;

  const code = parseSheetCode(result.data);
  if (!code) return null;

  const loc = result.location;
  const corners = orderCorners([
    loc.topLeftCorner,
    loc.topRightCorner,
    loc.bottomRightCorner,
    loc.bottomLeftCorner,
  ]);
  if (!corners) return null;

  return { code, corners, raw: result.data };
}
