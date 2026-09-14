import type { Rig } from "./types";

/**
 * Bake one child's colouring into a single ready-to-draw texture.
 *
 * Done once per dinosaur rather than per frame. The alternative - keeping the shared
 * sheet and masking live - costs a GPU pass per dinosaur every frame for a result
 * that never changes after the sheet is scanned.
 *
 * The result is: the child's crayon, clipped to the silhouette, shaded by the
 * whole-body form shading, with the printed outline on top. One canvas in the
 * canonical texture space, so the mesh's UVs address it directly.
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

/** Cache of the shared layers: identical for every dinosaur of a species. */
const artCache = new Map<string, Promise<HTMLImageElement>>();

function cachedImage(src: string): Promise<HTMLImageElement> {
  let pending = artCache.get(src);
  if (!pending) {
    pending = loadImage(src);
    artCache.set(src, pending);
  }
  return pending;
}

export async function compositeRig(
  rig: Rig,
  colouring: CanvasImageSource,
): Promise<HTMLCanvasElement> {
  const [silhouette, shade, lineart] = await Promise.all([
    cachedImage(rig.layers.silhouette),
    cachedImage(rig.layers.shade),
    cachedImage(rig.layers.lineart),
  ]);

  const { w, h } = rig.texture;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");

  // 1. The child's crayon, in canonical space.
  ctx.drawImage(colouring, 0, 0, w, h);

  // 2. Clip to the silhouette. This is what makes a scribble far outside the lines
  //    come out looking deliberate.
  ctx.globalCompositeOperation = "destination-in";
  ctx.drawImage(silhouette, 0, 0, w, h);

  // 3. Form shading: a soft band along the shaded edge and nothing in the middle, so
  //    paper a child left white stays white.
  ctx.globalCompositeOperation = "multiply";
  ctx.drawImage(shade, 0, 0, w, h);

  // 4. The printed outline last, which also hides the silhouette's own edge.
  ctx.globalCompositeOperation = "source-over";
  ctx.drawImage(lineart, 0, 0, w, h);

  return canvas;
}

export function decodeTexture(dataUrl: string): Promise<HTMLImageElement> {
  return loadImage(dataUrl);
}
