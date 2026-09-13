import type { RgbaImage } from "./image";

/**
 * Browser glue for the capture pipeline. Everything else in lib/vision is plain
 * arithmetic over pixel buffers so it can be tested under Node; this file is the
 * only part that needs a DOM.
 */

function scratch(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2d context unavailable");
  return [canvas, ctx];
}

/**
 * @param maxWidth downscale target. Live guidance runs smaller than the final
 *                 capture: QR decoding is the slow step and it scales with pixel
 *                 count, so a full-resolution preview loop would drop to a
 *                 slideshow and make the phone hard to aim.
 */
export function grabFrame(
  source: HTMLVideoElement | HTMLImageElement,
  maxWidth?: number,
): RgbaImage {
  const naturalWidth =
    source instanceof HTMLVideoElement ? source.videoWidth : source.naturalWidth;
  const naturalHeight =
    source instanceof HTMLVideoElement ? source.videoHeight : source.naturalHeight;
  if (!naturalWidth || !naturalHeight) throw new Error("source has no dimensions yet");

  const scale = maxWidth ? Math.min(1, maxWidth / naturalWidth) : 1;
  const width = Math.round(naturalWidth * scale);
  const height = Math.round(naturalHeight * scale);

  const [, ctx] = scratch(width, height);
  ctx.drawImage(source, 0, 0, width, height);
  const data = ctx.getImageData(0, 0, width, height);
  return { data: data.data, width, height };
}

export function toCanvas(image: RgbaImage): HTMLCanvasElement {
  const [canvas, ctx] = scratch(image.width, image.height);
  // Built through createImageData rather than the ImageData constructor: our buffers
  // are typed over ArrayBufferLike, which the constructor's signature rejects.
  const target = ctx.createImageData(image.width, image.height);
  target.data.set(image.data);
  ctx.putImageData(target, 0, 0);
  return canvas;
}

/**
 * WebP at 0.82 puts a rectified sheet around 70-130KB - small enough to move
 * through the relay in one message, detailed enough that crayon texture survives.
 */
export function encodeWebp(canvas: HTMLCanvasElement, quality = 0.82): string {
  return canvas.toDataURL("image/webp", quality);
}

export async function openRearCamera(video: HTMLVideoElement): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  return stream;
}

export function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}
