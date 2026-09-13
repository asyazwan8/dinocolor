import type { Pt } from "@/lib/sheet/geometry";

/**
 * Structurally compatible with the DOM ImageData, but declared here so the whole
 * pipeline runs under Node in tests without a browser or a canvas polyfill.
 */
export interface RgbaImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface GrayImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Rec. 709 luma. */
export function toGray(img: RgbaImage): GrayImage {
  const n = img.width * img.height;
  const out = new Uint8ClampedArray(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    out[i] = (img.data[o] * 0.2126 + img.data[o + 1] * 0.7152 + img.data[o + 2] * 0.0722) | 0;
  }
  return { data: out, width: img.width, height: img.height };
}

export function grayAt(img: GrayImage, x: number, y: number): number {
  const xi = x < 0 ? 0 : x >= img.width ? img.width - 1 : x | 0;
  const yi = y < 0 ? 0 : y >= img.height ? img.height - 1 : y | 0;
  return img.data[yi * img.width + xi];
}

/** Bilinear RGBA sample. Out-of-bounds clamps to the edge. */
export function sampleBilinear(img: RgbaImage, x: number, y: number, out: number[]): void {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;

  const cx = (v: number) => (v < 0 ? 0 : v >= img.width ? img.width - 1 : v);
  const cy = (v: number) => (v < 0 ? 0 : v >= img.height ? img.height - 1 : v);

  const x0c = cx(x0);
  const x1c = cx(x0 + 1);
  const y0c = cy(y0);
  const y1c = cy(y0 + 1);

  const i00 = (y0c * img.width + x0c) * 4;
  const i10 = (y0c * img.width + x1c) * 4;
  const i01 = (y1c * img.width + x0c) * 4;
  const i11 = (y1c * img.width + x1c) * 4;

  const w00 = (1 - fx) * (1 - fy);
  const w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy;
  const w11 = fx * fy;

  for (let c = 0; c < 4; c++) {
    out[c] =
      img.data[i00 + c] * w00 +
      img.data[i10 + c] * w10 +
      img.data[i01 + c] * w01 +
      img.data[i11 + c] * w11;
  }
}

export function distance(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Shoelace area. Sign tells winding, so callers take the absolute value. */
export function polygonArea(pts: Pt[]): number {
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}
