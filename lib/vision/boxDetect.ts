import { BOX_OUTER_CANVAS_CORNERS, type Pt } from "@/lib/sheet/geometry";
import { applyH, type Mat3 } from "./homography";
import { grayAt, type GrayImage } from "./image";

/**
 * Refine the printed box outline to sub-pixel accuracy.
 *
 * The QR alone does give a homography, but it spans about a tenth of the sheet, so
 * extrapolating it to the far corners multiplies any corner error roughly tenfold.
 * The printed border spans the whole sheet, so fitting to it collapses that error.
 * This is the step that makes capture work on a real table rather than only on a
 * flat, evenly lit one.
 *
 * Strategy: walk along each predicted edge, search perpendicular for the darkest
 * pixel, fit a line through the hits, then intersect adjacent lines for the corners.
 * Fitting lines rather than trusting individual hits means a few bad samples (a
 * shadow, a crayon mark crossing the border) cannot move a corner much.
 */

export interface Line {
  /** Normal form: nx*x + ny*y = c, with (nx, ny) unit length. */
  nx: number;
  ny: number;
  c: number;
}

export interface BoxDetectOptions {
  /** Samples taken along each edge. */
  samplesPerEdge: number;
  /**
   * Absolute probe radius in pixels. Leave undefined to derive it from the predicted
   * sheet size, which is what lets the same code serve both the wide first pass and
   * the tight second pass.
   */
  searchRadius?: number;
  /** Probe radius as a fraction of the shorter predicted edge, when not absolute. */
  searchRadiusFraction: number;
  /** An edge is accepted only if at least this fraction of samples found ink. */
  minInlierRatio: number;
  /** A hit must be at least this much darker than the local bright reference. */
  minContrast: number;
  /**
   * Shortest dark run, in pixels, accepted as the border. Rejects crayon strokes and
   * line art that happen to cross the probe, which are thin by comparison.
   */
  minRunLength: number;
}

export const DEFAULT_BOX_OPTIONS: BoxDetectOptions = {
  samplesPerEdge: 48,
  searchRadiusFraction: 0.09,
  minInlierRatio: 0.45,
  minContrast: 40,
  minRunLength: 3,
};

/** Total-least-squares line fit. Handles vertical lines, unlike y = mx + c. */
export function fitLine(points: Pt[]): Line | null {
  const n = points.length;
  if (n < 2) return null;

  let mx = 0;
  let my = 0;
  for (const p of points) {
    mx += p.x;
    my += p.y;
  }
  mx /= n;
  my /= n;

  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of points) {
    const dx = p.x - mx;
    const dy = p.y - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }

  // Principal axis of the scatter; the normal is perpendicular to it.
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const nx = -Math.sin(theta);
  const ny = Math.cos(theta);
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) return null;

  return { nx, ny, c: nx * mx + ny * my };
}

export function intersectLines(a: Line, b: Line): Pt | null {
  const det = a.nx * b.ny - a.ny * b.nx;
  // Near-parallel edges mean the fit failed; a corner from them would be nonsense.
  if (Math.abs(det) < 1e-6) return null;
  return {
    x: (a.c * b.ny - a.ny * b.c) / det,
    y: (a.nx * b.c - a.c * b.nx) / det,
  };
}

/**
 * Find where the printed border's OUTER edge crosses this probe, to sub-pixel
 * accuracy.
 *
 * The border is a thick dark band with paper either side, so the profile reads
 * light - dark - light. We want the outward boundary of that band, because that is
 * what BOX_OUTER_CANVAS_CORNERS names. Taking the darkest sample instead would land
 * somewhere inside the band, biasing every edge inward by half the border width.
 *
 * Probes run outside-to-inside (the corner winding makes the normal point inward),
 * and of all the dark runs found we take the one whose outer boundary sits nearest
 * the predicted position. Nearest rather than first, so that a dark table under the
 * sheet cannot capture the fit before the real border is reached.
 */
function probeForEdge(
  gray: GrayImage,
  origin: Pt,
  nx: number,
  ny: number,
  radius: number,
  minContrast: number,
  minRunLength: number,
): Pt | null {
  const samples: number[] = [];
  for (let t = -radius; t <= radius; t++) {
    samples.push(grayAt(gray, origin.x + nx * t, origin.y + ny * t));
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const dark = sorted[Math.floor(sorted.length * 0.05)];
  const bright = sorted[Math.floor(sorted.length * 0.9)];
  if (bright - dark < minContrast) return null;

  // Halfway between the profile's own light and dark levels, so the crossing point
  // does not move when the whole photo is dim.
  const threshold = (bright + dark) / 2;

  let best: { t: number; distance: number } | null = null;
  let runStart = -1;

  for (let i = 0; i <= samples.length; i++) {
    const isDark = i < samples.length && samples[i] < threshold;

    if (isDark && runStart < 0) {
      runStart = i;
    } else if (!isDark && runStart >= 0) {
      if (i - runStart >= minRunLength && runStart > 0) {
        // Linear interpolation across the light-to-dark crossing.
        const before = samples[runStart - 1];
        const after = samples[runStart];
        const frac = before === after ? 0 : (before - threshold) / (before - after);
        const t = runStart - 1 + frac - radius;
        const distance = Math.abs(t);
        if (!best || distance < best.distance) best = { t, distance };
      }
      runStart = -1;
    }
  }

  if (!best) return null;
  return { x: origin.x + nx * best.t, y: origin.y + ny * best.t };
}

export interface BoxDetectResult {
  corners: Pt[];
  /** Fraction of probes that found the border, averaged over the four edges. */
  confidence: number;
}

/**
 * @param gray   the camera frame
 * @param coarse homography mapping canonical space -> image space
 */
export function refineBoxCorners(
  gray: GrayImage,
  coarse: Mat3,
  options: Partial<BoxDetectOptions> = {},
): BoxDetectResult | null {
  const opts = { ...DEFAULT_BOX_OPTIONS, ...options };
  const predicted = BOX_OUTER_CANVAS_CORNERS.map((p) => applyH(coarse, p));
  if (predicted.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return null;

  // A probe radius proportional to the sheet keeps behaviour identical whether the
  // photo is 720p or 4K, and lets the caller widen it for a rough first pass.
  const edgeLengths = predicted.map((p, i) => {
    const q = predicted[(i + 1) % 4];
    return Math.hypot(q.x - p.x, q.y - p.y);
  });
  const radius = Math.max(
    4,
    Math.round(opts.searchRadius ?? Math.min(...edgeLengths) * opts.searchRadiusFraction),
  );

  const lines: Line[] = [];
  let inlierTotal = 0;

  for (let e = 0; e < 4; e++) {
    const a = predicted[e];
    const b = predicted[(e + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1) return null;

    // Unit normal to this edge, the direction the probe searches.
    const nx = -(b.y - a.y) / len;
    const ny = (b.x - a.x) / len;

    const hits: Pt[] = [];
    for (let s = 0; s < opts.samplesPerEdge; s++) {
      // Skip the ends: near a corner the two borders meet and the probe would
      // lock onto the wrong edge.
      const f = 0.08 + (0.84 * s) / (opts.samplesPerEdge - 1);
      const origin = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
      const hit = probeForEdge(
        gray, origin, nx, ny, radius, opts.minContrast, opts.minRunLength,
      );
      if (hit) hits.push(hit);
    }

    const ratio = hits.length / opts.samplesPerEdge;
    if (ratio < opts.minInlierRatio) return null;
    inlierTotal += ratio;

    const line = fitLine(hits);
    if (!line) return null;
    lines.push(line);
  }

  const corners: Pt[] = [];
  for (let i = 0; i < 4; i++) {
    // Corner i is where edge i-1 meets edge i.
    const p = intersectLines(lines[(i + 3) % 4], lines[i]);
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    corners.push(p);
  }

  return { corners, confidence: inlierTotal / 4 };
}
