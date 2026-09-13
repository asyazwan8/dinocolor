import { QR_CANVAS_CORNERS, QR_MM, PX_PER_MM } from "@/lib/sheet/geometry";
import type { RgbaImage } from "./image";

/**
 * Neutralise the colour cast of the room.
 *
 * Crayon photographed under warm indoor light reads strongly yellow, and a child's
 * careful blue dinosaur arriving on screen looking green is the kind of failure that
 * is obvious to them and invisible in testing under daylight.
 *
 * The reference is the printed quiet zone around the QR: by construction it is bare
 * paper, it is always present, and the line art is forbidden from entering it. That
 * makes it a known-white patch in every single capture, which beats guessing a white
 * point from image statistics that a big block of colour would skew.
 */

/** Where a correctly exposed sheet's paper should land. Not 255, to leave headroom. */
const TARGET_WHITE = 243;

/** Refuse to correct beyond this, so one bad sample cannot wreck the capture. */
const MIN_GAIN = 0.55;
const MAX_GAIN = 2.2;

export interface WhitePoint {
  r: number;
  g: number;
  b: number;
  /** Samples that contributed. Low means the quiet zone was not found cleanly. */
  samples: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Sample the ring of paper between the QR symbol and the art. */
export function estimateWhitePoint(img: RgbaImage): WhitePoint | null {
  const quiet = QR_MM.quiet * PX_PER_MM;
  const inner = {
    x0: QR_CANVAS_CORNERS[0].x,
    y0: QR_CANVAS_CORNERS[0].y,
    x1: QR_CANVAS_CORNERS[2].x,
    y1: QR_CANVAS_CORNERS[2].y,
  };
  const outer = {
    x0: inner.x0 - quiet,
    y0: inner.y0 - quiet,
    x1: inner.x1 + quiet,
    y1: inner.y1 + quiet,
  };

  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];

  for (let y = Math.floor(outer.y0); y < outer.y1; y += 2) {
    for (let x = Math.floor(outer.x0); x < outer.x1; x += 2) {
      const insideSymbol = x >= inner.x0 && x < inner.x1 && y >= inner.y0 && y < inner.y1;
      if (insideSymbol) continue;
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;

      const o = (y * img.width + x) * 4;
      rs.push(img.data[o]);
      gs.push(img.data[o + 1]);
      bs.push(img.data[o + 2]);
    }
  }

  if (rs.length < 32) return null;

  // Median, not mean: a smudge or a clipped QR corner intruding into the ring shifts
  // a mean but barely moves a median.
  return { r: median(rs), g: median(gs), b: median(bs), samples: rs.length };
}

export function applyWhiteBalance(img: RgbaImage, white: WhitePoint): RgbaImage {
  const clamp = (gain: number) =>
    Number.isFinite(gain) ? Math.min(MAX_GAIN, Math.max(MIN_GAIN, gain)) : 1;

  const gr = clamp(TARGET_WHITE / Math.max(1, white.r));
  const gg = clamp(TARGET_WHITE / Math.max(1, white.g));
  const gb = clamp(TARGET_WHITE / Math.max(1, white.b));

  const out = new Uint8ClampedArray(img.data.length);
  for (let i = 0; i < img.data.length; i += 4) {
    out[i] = img.data[i] * gr;
    out[i + 1] = img.data[i + 1] * gg;
    out[i + 2] = img.data[i + 2] * gb;
    out[i + 3] = img.data[i + 3];
  }

  return { data: out, width: img.width, height: img.height };
}

/** Convenience: estimate and apply, passing the image through if no reference found. */
export function autoWhiteBalance(img: RgbaImage): { image: RgbaImage; white: WhitePoint | null } {
  const white = estimateWhitePoint(img);
  return { image: white ? applyWhiteBalance(img, white) : img, white };
}
