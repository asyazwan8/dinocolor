import type { Pt } from "@/lib/sheet/geometry";

/** Row-major 3x3. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function mat3Mul(a: Mat3, b: Mat3): Mat3 {
  const out = new Array(9).fill(0) as Mat3;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += a[r * 3 + k] * b[k * 3 + c];
      out[r * 3 + c] = s;
    }
  }
  return out;
}

export function mat3Inv(m: Mat3): Mat3 | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-14) return null;

  return [
    A / det,
    (c * h - b * i) / det,
    (b * f - c * e) / det,
    B / det,
    (a * i - c * g) / det,
    (c * d - a * f) / det,
    C / det,
    (b * g - a * h) / det,
    (a * e - b * d) / det,
  ];
}

export function applyH(m: Mat3, p: Pt): Pt {
  const w = m[6] * p.x + m[7] * p.y + m[8];
  if (Math.abs(w) < 1e-14) return { x: NaN, y: NaN };
  return {
    x: (m[0] * p.x + m[1] * p.y + m[2]) / w,
    y: (m[3] * p.x + m[4] * p.y + m[5]) / w,
  };
}

/** Gauss-Jordan with partial pivoting. Returns null if singular. */
function solveLinearSystem(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    }
    if (Math.abs(m[pivot][col]) < 1e-12) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];

    const d = m[col][col];
    for (let c = col; c <= n; c++) m[col][c] /= d;

    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = m[r][col];
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) m[r][c] -= factor * m[col][c];
    }
  }

  const out = m.map((row) => row[n]);
  return out.every(Number.isFinite) ? out : null;
}

/**
 * Hartley normalisation: centre on the origin and scale so mean distance is sqrt(2).
 *
 * Without this, solving for a homography from pixel coordinates in the hundreds
 * produces a wildly ill-conditioned system — the quadratic terms dwarf the linear
 * ones and the solution is dominated by floating-point noise. This is the single
 * most important line of defence for accuracy.
 */
function normalizePoints(pts: Pt[]): { t: Mat3; out: Pt[] } {
  const n = pts.length;
  let cx = 0;
  let cy = 0;
  for (const p of pts) {
    cx += p.x;
    cy += p.y;
  }
  cx /= n;
  cy /= n;

  let mean = 0;
  for (const p of pts) mean += Math.hypot(p.x - cx, p.y - cy);
  mean /= n;

  const s = mean > 1e-12 ? Math.SQRT2 / mean : 1;
  return {
    t: [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1],
    out: pts.map((p) => ({ x: (p.x - cx) * s, y: (p.y - cy) * s })),
  };
}

/**
 * Direct Linear Transform. Four correspondences give an exact solution; more are
 * absorbed as least squares, which is how box corners and QR corners get combined.
 */
export function solveHomography(src: Pt[], dst: Pt[]): Mat3 | null {
  if (src.length !== dst.length || src.length < 4) return null;
  if (![...src, ...dst].every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) return null;

  const ns = normalizePoints(src);
  const nd = normalizePoints(dst);

  const rows: number[][] = [];
  const rhs: number[] = [];
  for (let i = 0; i < src.length; i++) {
    const { x, y } = ns.out[i];
    const { x: u, y: v } = nd.out[i];
    rows.push([x, y, 1, 0, 0, 0, -x * u, -y * u]);
    rhs.push(u);
    rows.push([0, 0, 0, x, y, 1, -x * v, -y * v]);
    rhs.push(v);
  }

  // Normal equations: (A^T A) h = A^T b, an 8x8 solve regardless of point count.
  const ata: number[][] = Array.from({ length: 8 }, () => new Array(8).fill(0));
  const atb: number[] = new Array(8).fill(0);
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    for (let i = 0; i < 8; i++) {
      atb[i] += row[i] * rhs[r];
      for (let j = 0; j < 8; j++) ata[i][j] += row[i] * row[j];
    }
  }

  const h = solveLinearSystem(ata, atb);
  if (!h) return null;

  const normalized: Mat3 = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  const dstInv = mat3Inv(nd.t);
  if (!dstInv) return null;

  const m = mat3Mul(mat3Mul(dstInv, normalized), ns.t);
  if (Math.abs(m[8]) < 1e-14) return null;
  return m.map((v) => v / m[8]) as Mat3;
}


/**
 * Fit a similarity transform: rotation, uniform scale and translation only.
 *
 * Used for the coarse fit from the QR, and deliberately NOT a full homography. Four
 * corners of a symbol spanning a tenth of the sheet cannot constrain perspective
 * terms: tiny corner errors produce a large spurious keystone which then blows up
 * non-linearly with distance, putting the far corners hundreds of pixels out. A
 * similarity has no perspective terms to get wrong, so its error grows only linearly
 * and it stays a usable starting point right across the sheet.
 *
 *   u = a*x - b*y + tx
 *   v = b*x + a*y + ty
 */
export function solveSimilarity(src: Pt[], dst: Pt[]): Mat3 | null {
  if (src.length !== dst.length || src.length < 2) return null;

  const rows: number[][] = [];
  const rhs: number[] = [];
  for (let i = 0; i < src.length; i++) {
    rows.push([src[i].x, -src[i].y, 1, 0]);
    rhs.push(dst[i].x);
    rows.push([src[i].y, src[i].x, 0, 1]);
    rhs.push(dst[i].y);
  }

  const ata: number[][] = Array.from({ length: 4 }, () => new Array(4).fill(0));
  const atb: number[] = new Array(4).fill(0);
  for (let r = 0; r < rows.length; r++) {
    for (let i = 0; i < 4; i++) {
      atb[i] += rows[r][i] * rhs[r];
      for (let j = 0; j < 4; j++) ata[i][j] += rows[r][i] * rows[r][j];
    }
  }

  const v = solveLinearSystem(ata, atb);
  if (!v) return null;

  const [a, b, tx, ty] = v;
  if (Math.hypot(a, b) < 1e-9) return null;
  return [a, -b, tx, b, a, ty, 0, 0, 1];
}

/** RMS reprojection error in destination units. The honest quality signal. */
export function reprojectionRms(m: Mat3, src: Pt[], dst: Pt[]): number {
  let sum = 0;
  for (let i = 0; i < src.length; i++) {
    const p = applyH(m, src[i]);
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return Infinity;
    sum += (p.x - dst[i].x) ** 2 + (p.y - dst[i].y) ** 2;
  }
  return Math.sqrt(sum / src.length);
}

/**
 * Sort four points into TL, TR, BR, BL.
 *
 * Detectors return corners in arbitrary order; the homography needs them to line up
 * with the canonical corners. Sorting by angle about the centroid is orientation
 * agnostic, so it survives the sheet being photographed rotated.
 */
export function orderCorners(pts: Pt[]): Pt[] | null {
  if (pts.length !== 4) return null;

  const cx = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4;
  const cy = (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4;

  // Screen coords put +y downward, so this walks clockwise from the top-left.
  const sorted = [...pts].sort(
    (a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx),
  );

  let start = 0;
  let best = Infinity;
  for (let i = 0; i < 4; i++) {
    const d = (sorted[i].x - cx) ** 2 + (sorted[i].y - cy) ** 2;
    const isUpperLeft = sorted[i].x < cx && sorted[i].y < cy;
    const score = isUpperLeft ? d - 1e9 : d;
    if (score < best) {
      best = score;
      start = i;
    }
  }

  return [0, 1, 2, 3].map((i) => sorted[(start + i) % 4]);
}
