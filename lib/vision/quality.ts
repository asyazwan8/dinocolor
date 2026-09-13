import type { Pt } from "@/lib/sheet/geometry";
import { grayAt, polygonArea, type GrayImage } from "./image";

/**
 * Gate a capture before it is sent.
 *
 * A bad capture that goes through is worse than one that is refused: the child
 * watches a muddy, skewed dinosaur walk onto a screen in front of everyone. Refusing
 * early and saying which way to move costs a second and fixes the cause.
 */

export interface QualityMetrics {
  /** Variance of the Laplacian inside the sheet. Low means motion blur or bad focus. */
  sharpness: number;
  /** Sheet area as a fraction of the frame. */
  coverage: number;
  /** Median luminance inside the sheet. */
  exposure: number;
  /**
   * Spread between the 5th and 95th percentile luminance. A sheet always contains
   * both black border and white paper, so a healthy capture has a wide range;
   * a narrow one means glare, fog or a washed-out auto-exposure.
   */
  dynamicRange: number;
  /** 0 = perfectly rectangular in frame, larger = more extreme angle. */
  skew: number;
}

export interface QualityVerdict {
  ok: boolean;
  /** Short instruction aimed at the person holding the phone. */
  hint?: string;
  metrics: QualityMetrics;
}

export const QUALITY_THRESHOLDS = {
  minSharpness: 55,
  minCoverage: 0.12,
  minExposure: 60,
  minDynamicRange: 45,
  maxSkew: 0.42,
} as const;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[i];
}

export function measureQuality(gray: GrayImage, corners: Pt[]): QualityMetrics {
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const x0 = Math.max(1, Math.floor(Math.min(...xs)));
  const y0 = Math.max(1, Math.floor(Math.min(...ys)));
  const x1 = Math.min(gray.width - 2, Math.ceil(Math.max(...xs)));
  const y1 = Math.min(gray.height - 2, Math.ceil(Math.max(...ys)));

  const step = Math.max(1, Math.floor(Math.min(x1 - x0, y1 - y0) / 120));
  const lap: number[] = [];
  const lum: number[] = [];

  for (let y = y0; y <= y1; y += step) {
    for (let x = x0; x <= x1; x += step) {
      const c = grayAt(gray, x, y);
      lum.push(c);
      lap.push(
        grayAt(gray, x - 1, y) +
          grayAt(gray, x + 1, y) +
          grayAt(gray, x, y - 1) +
          grayAt(gray, x, y + 1) -
          4 * c,
      );
    }
  }

  let mean = 0;
  for (const v of lap) mean += v;
  mean /= Math.max(1, lap.length);
  let variance = 0;
  for (const v of lap) variance += (v - mean) ** 2;
  variance /= Math.max(1, lap.length);

  // Skew: how unequal the two pairs of opposite edges are. A square-on shot gives
  // near-identical pairs; a steep angle makes the far edge much shorter.
  const side = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
  const top = side(corners[0], corners[1]);
  const right = side(corners[1], corners[2]);
  const bottom = side(corners[2], corners[3]);
  const left = side(corners[3], corners[0]);
  const horizontalSkew = Math.abs(top - bottom) / Math.max(1, Math.max(top, bottom));
  const verticalSkew = Math.abs(left - right) / Math.max(1, Math.max(left, right));

  const sortedLum = lum.sort((a, b) => a - b);

  return {
    sharpness: variance,
    coverage: polygonArea(corners) / (gray.width * gray.height),
    exposure: percentile(sortedLum, 0.5),
    dynamicRange: percentile(sortedLum, 0.95) - percentile(sortedLum, 0.05),
    skew: Math.max(horizontalSkew, verticalSkew),
  };
}

export function assessQuality(gray: GrayImage, corners: Pt[]): QualityVerdict {
  const metrics = measureQuality(gray, corners);
  const t = QUALITY_THRESHOLDS;

  // Ordered by what the person should fix first. Framing before focus: stepping
  // closer usually fixes sharpness too, so asking for that first avoids a second
  // round of instructions.
  let hint: string | undefined;
  if (metrics.coverage < t.minCoverage) hint = "Move closer";
  else if (metrics.exposure < t.minExposure) hint = "Needs more light";
  else if (metrics.dynamicRange < t.minDynamicRange) hint = "Avoid the glare";
  else if (metrics.skew > t.maxSkew) hint = "Hold the phone flat above the sheet";
  else if (metrics.sharpness < t.minSharpness) hint = "Hold steady";

  return { ok: hint === undefined, hint, metrics };
}
