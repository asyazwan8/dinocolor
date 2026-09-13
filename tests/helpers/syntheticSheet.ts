import QRCode from "qrcode";
import { formatSheetCode } from "@/lib/sheet/code";
import {
  BOX_BORDER_MM,
  BOX_INNER_MM,
  BOX_OUTER_MM,
  PAGE_MM,
  PX_PER_MM,
  QR_MM,
} from "@/lib/sheet/geometry";
import type { DinoType } from "@/lib/sheet/types";
import { mat3Mul, type Mat3 } from "@/lib/vision/homography";
import type { RgbaImage } from "@/lib/vision/image";

/**
 * Build a printed sheet and a photograph of it, entirely in memory.
 *
 * This exists so the capture pipeline has a regression suite that needs no phone, no
 * browser and no committed fixture image. Ground truth is known exactly, so the test
 * can assert on corner error in millimetres rather than eyeballing an overlay.
 */

export const PAGE_PX = {
  w: Math.round(PAGE_MM.w * PX_PER_MM),
  h: Math.round(PAGE_MM.h * PX_PER_MM),
};

/**
 * Canonical space and page space share a scale (both 5px/mm), so this is a pure
 * translation to the box interior.
 */
export const PAGE_FROM_CANVAS: Mat3 = [
  1, 0, BOX_INNER_MM.x * PX_PER_MM,
  0, 1, BOX_INNER_MM.y * PX_PER_MM,
  0, 0, 1,
];

function blankPage(): RgbaImage {
  const data = new Uint8ClampedArray(PAGE_PX.w * PAGE_PX.h * 4).fill(255);
  return { data, width: PAGE_PX.w, height: PAGE_PX.h };
}

function fillRect(
  img: RgbaImage,
  x: number, y: number, w: number, h: number,
  [r, g, b]: [number, number, number],
): void {
  const x0 = Math.max(0, Math.round(x));
  const y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(img.width, Math.round(x + w));
  const y1 = Math.min(img.height, Math.round(y + h));
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      const o = (py * img.width + px) * 4;
      img.data[o] = r;
      img.data[o + 1] = g;
      img.data[o + 2] = b;
    }
  }
}

export interface SyntheticSheetOptions {
  dino: DinoType;
  serial: string;
  /** Paint blocks of "crayon" inside the art area. */
  colouring: boolean;
}

/** Render the sheet exactly as the print route lays it out. */
export async function renderSheet(
  options: Partial<SyntheticSheetOptions> = {},
): Promise<{ page: RgbaImage; payload: string }> {
  const { dino = "TRI", serial = "0042", colouring = true } = options;
  const page = blankPage();
  const mm = (v: number) => v * PX_PER_MM;

  // Black border, drawn as an outer black rect with the interior painted back white.
  fillRect(page, mm(BOX_OUTER_MM.x), mm(BOX_OUTER_MM.y), mm(BOX_OUTER_MM.w), mm(BOX_OUTER_MM.h), [17, 17, 17]);
  fillRect(page, mm(BOX_INNER_MM.x), mm(BOX_INNER_MM.y), mm(BOX_INNER_MM.w), mm(BOX_INNER_MM.h), [255, 255, 255]);

  if (colouring) {
    // Crayon blocks well clear of the QR and its quiet zone.
    const swatches: Array<[number, number, number, number, number]> = [
      [40, 30, 300, 180, 0],
      [360, 60, 260, 150, 1],
      [80, 300, 420, 200, 2],
      [560, 330, 300, 190, 3],
    ];
    const palette: Array<[number, number, number]> = [
      [214, 64, 52], [232, 176, 44], [58, 132, 206], [78, 168, 82],
    ];
    for (const [x, y, w, h, c] of swatches) {
      fillRect(page, mm(BOX_INNER_MM.x) + x, mm(BOX_INNER_MM.y) + y, w, h, palette[c]);
    }
  }

  // Quiet zone stays bare paper: the white-balance reference depends on it.
  fillRect(
    page,
    mm(QR_MM.x - QR_MM.quiet), mm(QR_MM.y - QR_MM.quiet),
    mm(QR_MM.size + QR_MM.quiet * 2), mm(QR_MM.size + QR_MM.quiet * 2),
    [255, 255, 255],
  );

  const payload = formatSheetCode(dino, serial);
  const qr = QRCode.create(payload, { errorCorrectionLevel: "H" });
  const modules = qr.modules;
  const sizePx = mm(QR_MM.size);
  const scale = sizePx / modules.size;

  for (let my = 0; my < modules.size; my++) {
    for (let mx = 0; mx < modules.size; mx++) {
      if (!modules.data[my * modules.size + mx]) continue;
      fillRect(
        page,
        mm(QR_MM.x) + mx * scale, mm(QR_MM.y) + my * scale,
        Math.ceil(scale), Math.ceil(scale),
        [17, 17, 17],
      );
    }
  }

  return { page, payload };
}

export interface PhotoOptions {
  width: number;
  height: number;
  /** Corner offsets in photo pixels, applied to a centred sheet, to fake an angle. */
  warp: [number, number][];
  /** Per-channel multipliers, for a warm indoor cast. */
  cast: [number, number, number];
  brightness: number;
  /** Box-blur radius in pixels. */
  blur: number;
  /** Peak-to-peak uniform sensor noise. */
  noise: number;
  seed: number;
}

export const DEFAULT_PHOTO: PhotoOptions = {
  width: 1920,
  height: 1440,
  warp: [[0, 0], [0, 0], [0, 0], [0, 0]],
  cast: [1, 1, 1],
  brightness: 1,
  blur: 0,
  noise: 0,
  seed: 1,
};

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Separable box blur: two 1-D passes instead of an r^2 kernel, to keep tests quick. */
function boxBlur(img: RgbaImage, radius: number): RgbaImage {
  if (radius < 1) return img;
  const r = Math.round(radius);
  const { width, height } = img;

  const pass = (src: Uint8ClampedArray, horizontal: boolean): Uint8ClampedArray => {
    const dst = new Uint8ClampedArray(src.length);
    const outer = horizontal ? height : width;
    const inner = horizontal ? width : height;
    for (let a = 0; a < outer; a++) {
      for (let b = 0; b < inner; b++) {
        let sr = 0, sg = 0, sb = 0, n = 0;
        for (let d = -r; d <= r; d++) {
          const bb = b + d;
          if (bb < 0 || bb >= inner) continue;
          const o = (horizontal ? a * width + bb : bb * width + a) * 4;
          sr += src[o]; sg += src[o + 1]; sb += src[o + 2]; n++;
        }
        const o = (horizontal ? a * width + b : b * width + a) * 4;
        dst[o] = sr / n; dst[o + 1] = sg / n; dst[o + 2] = sb / n; dst[o + 3] = 255;
      }
    }
    return dst;
  };

  return { data: pass(pass(img.data, true), false), width, height };
}

/**
 * Where the sheet's four page-space corners land in the photo: centred, scaled to
 * leave a margin, then pushed around by the requested warp.
 */
export function photoQuad(options: PhotoOptions): Array<{ x: number; y: number }> {
  const margin = 0.06;
  const scale = Math.min(
    (options.width * (1 - margin * 2)) / PAGE_PX.w,
    (options.height * (1 - margin * 2)) / PAGE_PX.h,
  );
  const w = PAGE_PX.w * scale;
  const h = PAGE_PX.h * scale;
  const ox = (options.width - w) / 2;
  const oy = (options.height - h) / 2;

  return [
    { x: ox, y: oy },
    { x: ox + w, y: oy },
    { x: ox + w, y: oy + h },
    { x: ox, y: oy + h },
  ].map((p, i) => ({ x: p.x + options.warp[i][0], y: p.y + options.warp[i][1] }));
}

export const PAGE_CORNERS = [
  { x: 0, y: 0 },
  { x: PAGE_PX.w, y: 0 },
  { x: PAGE_PX.w, y: PAGE_PX.h },
  { x: 0, y: PAGE_PX.h },
];

/** Ground-truth homography taking canonical space straight to photo space. */
export function truthImageFromCanvas(photoFromPage: Mat3): Mat3 {
  return mat3Mul(photoFromPage, PAGE_FROM_CANVAS);
}

export function degrade(img: RgbaImage, options: PhotoOptions): RgbaImage {
  let out = boxBlur(img, options.blur);
  const rand = mulberry32(options.seed);
  const data = new Uint8ClampedArray(out.data);

  for (let i = 0; i < data.length; i += 4) {
    const n = options.noise ? (rand() - 0.5) * options.noise : 0;
    data[i] = data[i] * options.cast[0] * options.brightness + n;
    data[i + 1] = data[i + 1] * options.cast[1] * options.brightness + n;
    data[i + 2] = data[i + 2] * options.cast[2] * options.brightness + n;
    data[i + 3] = 255;
  }

  out = { data, width: out.width, height: out.height };
  return out;
}
