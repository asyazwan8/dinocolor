/**
 * THE CONTRACT.
 *
 * These constants are imported by BOTH the print page and the vision pipeline. If the
 * printed sheet and the rectifier ever disagree about where the box or the QR sits,
 * every capture is silently skewed. Change nothing here without re-running
 * tests/geometry.test.ts and reprinting.
 *
 * Numbers are chosen so 1mm maps to exactly 5 canonical pixels. Every documented
 * coordinate is therefore an exact integer, which makes the CV debuggable by eye.
 */

export interface Pt {
  x: number;
  y: number;
}

export interface RectMm {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A4 landscape. */
export const PAGE_MM = { w: 297, h: 210 } as const;

export const TITLE_BAND_MM: RectMm = { x: 0, y: 0, w: 297, h: 24 };

/** The black rectangle. Doubles as the perspective fiducial. */
export const BOX_OUTER_MM: RectMm = { x: 22.5, y: 24, w: 252, h: 172 };
export const BOX_BORDER_MM = 6;

/** The white area inside the border. This is what maps to the canonical texture. */
export const BOX_INNER_MM: RectMm = { x: 28.5, y: 30, w: 240, h: 160 };

/** QR sits inside the box so box and code are always captured together. */
export const QR_MM = { x: 236.5, y: 158, size: 24, quiet: 4 } as const;

export const FOOTER_MM: RectMm = { x: 0, y: 196, w: 297, h: 14 };

export const PX_PER_MM = 5;

/** Canonical rectified texture: the box inner rect at 5px/mm. Exactly 3:2. */
export const TEXTURE = { w: 1200, h: 800 } as const;

/** Page millimetres -> canonical pixels (origin at the box inner top-left). */
export function mmToCanvas(xMm: number, yMm: number): Pt {
  return {
    x: (xMm - BOX_INNER_MM.x) * PX_PER_MM,
    y: (yMm - BOX_INNER_MM.y) * PX_PER_MM,
  };
}

/** Canonical pixels -> page millimetres. */
export function canvasToMm(x: number, y: number): Pt {
  return {
    x: x / PX_PER_MM + BOX_INNER_MM.x,
    y: y / PX_PER_MM + BOX_INNER_MM.y,
  };
}

/** Corners in TL, TR, BR, BL order — the order every detector must return. */
function cornersOf(r: RectMm): Pt[] {
  return [
    mmToCanvas(r.x, r.y),
    mmToCanvas(r.x + r.w, r.y),
    mmToCanvas(r.x + r.w, r.y + r.h),
    mmToCanvas(r.x, r.y + r.h),
  ];
}

/** (0,0) .. (1200,800) by definition. */
export const BOX_INNER_CANVAS_CORNERS: Pt[] = cornersOf(BOX_INNER_MM);

/** (-30,-30) .. (1230,830) — the border lies outside the texture. */
export const BOX_OUTER_CANVAS_CORNERS: Pt[] = cornersOf(BOX_OUTER_MM);

/** (1040,640) .. (1160,760). Line art must leave this corner clear. */
export const QR_CANVAS_CORNERS: Pt[] = cornersOf({
  x: QR_MM.x,
  y: QR_MM.y,
  w: QR_MM.size,
  h: QR_MM.size,
});
