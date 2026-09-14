import type { Rig, RigPart } from "./types";

/**
 * Bake one child's colouring into ready-to-draw part textures.
 *
 * Done once per dinosaur rather than per frame. The alternative - keeping the shared
 * texture and applying each part's mask live - costs a GPU mask pass per part, which
 * at ten dinosaurs of eight parts is eighty extra passes every frame for a result
 * that never changes after the sheet is scanned.
 *
 * Each part ends up as: the child's crayon, clipped to the part silhouette, shaded to
 * give it volume, with the black outline on top.
 */

/** Light comes from the upper left, so shadow falls to the lower right. */
const SHADOW_OFFSET = { x: 7, y: 9 };
const SHADOW_BLUR = 12;
const SHADOW_STRENGTH = 0.42;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load ${src}`));
    img.src = src;
  });
}

export interface CompositedPart {
  part: RigPart;
  canvas: HTMLCanvasElement;
}

/** Cache of mask and line-art images: identical for every dinosaur of a species. */
const artCache = new Map<string, Promise<HTMLImageElement>>();

function cachedImage(src: string): Promise<HTMLImageElement> {
  let pending = artCache.get(src);
  if (!pending) {
    pending = loadImage(src);
    artCache.set(src, pending);
  }
  return pending;
}

function compositePart(
  colouring: CanvasImageSource,
  part: RigPart,
  mask: HTMLImageElement,
  lineart: HTMLImageElement,
): HTMLCanvasElement {
  const { w, h } = part.box;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");

  // 1. The child's crayon, cropped to this part's region of the sheet.
  ctx.drawImage(colouring, part.box.x, part.box.y, w, h, 0, 0, w, h);

  // 2. Form shadow. A blurred, offset copy of the silhouette multiplied over the
  //    colour reads as a rounded body rather than a flat paper cut-out. This is the
  //    cheap stand-in for a real shading map.
  const shade = document.createElement("canvas");
  shade.width = w;
  shade.height = h;
  const shadeCtx = shade.getContext("2d");
  if (shadeCtx) {
    shadeCtx.filter = `blur(${SHADOW_BLUR}px)`;
    shadeCtx.drawImage(mask, SHADOW_OFFSET.x, SHADOW_OFFSET.y, w, h);
    shadeCtx.filter = "none";
    shadeCtx.globalCompositeOperation = "source-in";
    shadeCtx.fillStyle = `rgba(60,44,30,${SHADOW_STRENGTH})`;
    shadeCtx.fillRect(0, 0, w, h);

    ctx.globalCompositeOperation = "multiply";
    ctx.drawImage(shade, 0, 0);
  }

  // 3. A soft highlight along the lit edge, for the other half of the roundness.
  //    Kept restrained: "lighter" adds, and crayon on white paper is already a light
  //    subject, so a strong pass here washes a child's colours out to nearly nothing.
  const light = ctx.createLinearGradient(0, 0, w * 0.8, h);
  light.addColorStop(0, "rgba(255,250,232,0.16)");
  light.addColorStop(0.45, "rgba(255,255,255,0)");
  ctx.globalCompositeOperation = "lighter";
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, w, h);

  // 4. Clip everything back to the silhouette. Steps 2 and 3 painted over the whole
  //    rectangle; this is what makes a child's scribble outside the lines disappear.
  ctx.globalCompositeOperation = "destination-in";
  ctx.drawImage(mask, 0, 0, w, h);

  // 5. The printed outline last, which also hides the mask's own edge.
  ctx.globalCompositeOperation = "source-over";
  ctx.drawImage(lineart, 0, 0, w, h);

  return canvas;
}

export async function compositeRig(
  rig: Rig,
  colouring: CanvasImageSource,
): Promise<CompositedPart[]> {
  const art = await Promise.all(
    rig.parts.map(async (part) => ({
      part,
      mask: await cachedImage(part.mask),
      lineart: await cachedImage(part.lineart),
    })),
  );

  return art.map(({ part, mask, lineart }) => ({
    part,
    canvas: compositePart(colouring, part, mask, lineart),
  }));
}

export function decodeTexture(dataUrl: string): Promise<HTMLImageElement> {
  return loadImage(dataUrl);
}
