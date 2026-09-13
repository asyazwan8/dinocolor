import { TEXTURE } from "@/lib/sheet/geometry";
import { type Mat3 } from "./homography";
import { sampleBilinear, type RgbaImage } from "./image";

/**
 * Warp a camera frame into the canonical sheet texture.
 *
 * Deliberately on the CPU. A WebGL pass would be faster, but this runs once per
 * capture rather than once per frame, so a few tens of milliseconds is invisible to
 * the user - and a plain loop runs identically in Node, which means the whole
 * pipeline is testable without a browser or a GPU.
 *
 * @param imageFromCanvas maps canonical space -> image space, so each output pixel
 *                        pulls its colour from the right place in the photo.
 */
export function rectify(
  src: RgbaImage,
  imageFromCanvas: Mat3,
  width: number = TEXTURE.w,
  height: number = TEXTURE.h,
): RgbaImage {
  const out = new Uint8ClampedArray(width * height * 4);
  const [a, b, c, d, e, f, g, h, i] = imageFromCanvas;
  const px: number[] = [0, 0, 0, 0];

  for (let y = 0; y < height; y++) {
    const cy = y + 0.5;
    for (let x = 0; x < width; x++) {
      const cx = x + 0.5;
      const w = g * cx + h * cy + i;
      const o = (y * width + x) * 4;

      if (Math.abs(w) < 1e-12) {
        out[o + 3] = 255;
        continue;
      }

      const sx = (a * cx + b * cy + c) / w;
      const sy = (d * cx + e * cy + f) / w;

      // Anything the camera did not actually see becomes opaque white rather than
      // transparent: downstream this is paper, and white is the honest stand-in.
      if (sx < -1 || sy < -1 || sx > src.width || sy > src.height) {
        out[o] = 255;
        out[o + 1] = 255;
        out[o + 2] = 255;
        out[o + 3] = 255;
        continue;
      }

      sampleBilinear(src, sx, sy, px);
      out[o] = px[0];
      out[o + 1] = px[1];
      out[o + 2] = px[2];
      out[o + 3] = 255;
    }
  }

  return { data: out, width, height };
}
