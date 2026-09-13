import {
  BOX_BORDER_MM,
  BOX_OUTER_CANVAS_CORNERS,
  PX_PER_MM,
  type Pt,
} from "@/lib/sheet/geometry";
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
   * Thinnest dark run accepted as the border, as a fraction of its predicted
   * thickness. Rejects line art, QR modules, the page edge and the sheet's own
   * drop shadow, all of which are fine at this scale.
   */
  minRunFraction: number;
  /**
   * Thickest dark run accepted, as a multiple of the predicted thickness. Rejects
   * blocks of crayon and the table beyond the page, which are far broader.
   */
  maxRunFactor: number;
}

export const DEFAULT_BOX_OPTIONS: BoxDetectOptions = {
  samplesPerEdge: 48,
  searchRadiusFraction: 0.09,
  minInlierRatio: 0.45,
  minContrast: 40,
  minRunFraction: 0.34,
  maxRunFactor: 3.4,
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
 * A probe crosses plenty of dark things that are not the border: a block of crayon,
 * the QR, the line art, the table beyond the page. Proximity alone cannot tell them
 * apart, because early passes predict from a model that is still wrong by more than
 * the gap between them. Thickness can: the border's width is known from the sheet
 * geometry, crayon is far broader and QR modules far finer. So candidates are
 * filtered by how well their thickness matches, and only then by which is nearest.
 */
function probeForEdge(
  gray: GrayImage,
  origin: Pt,
  nx: number,
  ny: number,
  radius: number,
  minContrast: number,
  expectedThickness: number,
  minRunFraction: number,
  maxRunFactor: number,
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
  const minRun = Math.max(2, expectedThickness * minRunFraction);
  const maxRun = expectedThickness * maxRunFactor;

  // Collected rather than tracked through a closure, so the best-of is a plain
  // reduction over the candidates.
  const candidates: { t: number; distance: number }[] = [];
  let runStart = -1;

  const consider = (from: number, to: number) => {
    const length = to - from;
    if (length < minRun || length > maxRun) return;
    if (from <= 0) return;

    // Linear interpolation across the light-to-dark crossing.
    const before = samples[from - 1];
    const after = samples[from];
    const frac = before === after ? 0 : (before - threshold) / (before - after);
    const t = from - 1 + frac - radius;
    candidates.push({ t, distance: Math.abs(t) });
  };

  for (let i = 0; i <= samples.length; i++) {
    const isDark = i < samples.length && samples[i] < threshold;
    if (isDark && runStart < 0) {
      runStart = i;
    } else if (!isDark && runStart >= 0) {
      consider(runStart, i);
      runStart = -1;
    }
  }

  if (!candidates.length) return null;
  const best = candidates.reduce((a, b) => (b.distance < a.distance ? b : a));
  return { x: origin.x + nx * best.t, y: origin.y + ny * best.t };
}

export interface BoxDetectResult {
  corners: Pt[];
  /** Fraction of probes that found the border, averaged over the four edges. */
  confidence: number;
  /** Per-edge inlier ratio, in TL-TR, TR-BR, BR-BL, BL-TL order. One weak edge is
   *  the usual cause of a bad fit, and an average hides it. */
  edgeConfidence: number[];
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
  const radiusFor = (edge: number) =>
    Math.max(
      4,
      Math.round(opts.searchRadius ?? edgeLengths[edge] * opts.searchRadiusFraction),
    );

  const lines: Line[] = [];
  const edgeConfidence: number[] = [];
  let inlierTotal = 0;

  const borderCanonical = BOX_BORDER_MM * PX_PER_MM;

  // Canonical centre of the box, so each edge can be offset inward along its own
  // normal to measure how thick the border appears on that edge.
  const canonicalCentre = {
    x: (BOX_OUTER_CANVAS_CORNERS[0].x + BOX_OUTER_CANVAS_CORNERS[2].x) / 2,
    y: (BOX_OUTER_CANVAS_CORNERS[0].y + BOX_OUTER_CANVAS_CORNERS[2].y) / 2,
  };

  /**
   * How thick the border looks in image pixels at one point along one edge.
   *
   * Sampled per probe rather than once per edge. Under a steep angle the border is
   * visibly fatter at the near end of an edge than the far end, so a single
   * mid-edge figure makes the thickness window wrong at both extremes and the real
   * border gets rejected exactly where the geometry is hardest.
   *
   * Measured by projecting the border's outer and inner faces, not by scaling edge
   * length: perspective compresses across an edge far more than along it.
   */
  const borderThickness = (edge: number, along: number): number => {
    const a = BOX_OUTER_CANVAS_CORNERS[edge];
    const b = BOX_OUTER_CANVAS_CORNERS[(edge + 1) % 4];
    const at = { x: a.x + (b.x - a.x) * along, y: a.y + (b.y - a.y) * along };
    const toCentre = { x: canonicalCentre.x - at.x, y: canonicalCentre.y - at.y };
    const norm = Math.hypot(toCentre.x, toCentre.y) || 1;
    const inner = {
      x: at.x + (toCentre.x / norm) * borderCanonical,
      y: at.y + (toCentre.y / norm) * borderCanonical,
    };
    const outerPx = applyH(coarse, at);
    const innerPx = applyH(coarse, inner);
    return Math.hypot(innerPx.x - outerPx.x, innerPx.y - outerPx.y);
  };

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
        gray, origin, nx, ny, radiusFor(e), opts.minContrast,
        borderThickness(e, f), opts.minRunFraction, opts.maxRunFactor,
      );
      if (hit) hits.push(hit);
    }

    const ratio = hits.length / opts.samplesPerEdge;
    edgeConfidence.push(ratio);
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

  return { corners, confidence: inlierTotal / 4, edgeConfidence };
}
