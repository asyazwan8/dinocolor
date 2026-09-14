import type { Rig, RigPart } from "./types";

/**
 * Bake one child's colouring into ready-to-draw part textures.
 *
 * Done once per dinosaur rather than per frame. The alternative - keeping the shared
 * texture and applying each part's mask live - costs a GPU mask pass per part, which
 * at ten dinosaurs of eight parts is eighty extra passes every frame for a result
 * that never changes after the sheet is scanned.
 *
 * Each part ends up as: the child's crayon, clipped to the part silhouette, shaded by
 * a slice of the whole-body form shading, with the printed outline on top.
 */

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
  shade: HTMLImageElement,
): HTMLCanvasElement {
  const { w, h } = part.box;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");

  // 1. The child's crayon, cropped to this part's region of the sheet.
  ctx.drawImage(colouring, part.box.x, part.box.y, w, h, 0, 0, w, h);

  // 2. Clip to the silhouette. This is what makes a scribble far outside the lines
  //    come out looking deliberate.
  ctx.globalCompositeOperation = "destination-in";
  ctx.drawImage(mask, 0, 0, w, h);

  // 3. Form shading, baked at build time across the WHOLE dinosaur and sliced. It is
  //    a soft band along the shaded edge and nothing in the middle, so paper a child
  //    left white stays white - and because it never knew about part boundaries, it
  //    runs continuously across them instead of revealing them as panels.
  ctx.globalCompositeOperation = "multiply";
  ctx.drawImage(shade, 0, 0, w, h);

  // 4. The printed outline last, which also hides the mask's own edge.
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
      shade: await cachedImage(part.shade),
    })),
  );

  return art.map(({ part, mask, lineart, shade }) => ({
    part,
    canvas: compositePart(colouring, part, mask, lineart, shade),
  }));
}

export function decodeTexture(dataUrl: string): Promise<HTMLImageElement> {
  return loadImage(dataUrl);
}
