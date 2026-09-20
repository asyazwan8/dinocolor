import type { Rig, RigPart } from "./types";

/**
 * Bake one child's colouring into one ready-to-draw cut-out per rigged part.
 *
 * Done once per dinosaur rather than per frame. The alternative - keeping the shared
 * sheet and masking live - costs a GPU pass per dinosaur every frame for a result that
 * never changes after the sheet is scanned.
 *
 * Every part is cut from the SAME composited sheet at its own rest position, so a part
 * takes exactly the crayon the child put there. That includes the buried top of a leg,
 * which lies under the belly on the sheet and so comes out the belly's colour - which
 * is the right colour for a thigh anyway, and is the child's own crayon either way.
 * Nothing is invented to fill a hidden region.
 *
 * Cutting rather than clipping a shared texture at draw time is what keeps the edges
 * exact: the mask is the artist's own line, at full resolution, with no triangles to
 * staircase along it.
 */

/** One part's crayon, cropped to its box and cut to its mask. */
export interface CompositedPart {
  id: string;
  canvas: HTMLCanvasElement;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load ${src}`));
    img.src = src;
  });
}

/** Cache of the shared layers and masks: identical for every dinosaur of a species. */
const artCache = new Map<string, Promise<HTMLImageElement>>();

function cachedImage(src: string): Promise<HTMLImageElement> {
  let pending = artCache.get(src);
  if (!pending) {
    pending = loadImage(src);
    artCache.set(src, pending);
  }
  return pending;
}

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  return [canvas, ctx];
}

export async function compositeRig(
  rig: Rig,
  colouring: CanvasImageSource,
): Promise<CompositedPart[]> {
  const [silhouette, shade, lineart, ...masks] = await Promise.all([
    cachedImage(rig.layers.silhouette),
    cachedImage(rig.layers.shade),
    cachedImage(rig.layers.lineart),
    ...rig.parts.map((part) => cachedImage(part.mask)),
  ]);

  const { w, h } = rig.texture;
  const [, ctx] = makeCanvas(w, h);

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

  const sheet = ctx.canvas;
  return rig.parts.map((part: RigPart, index) => {
    const { box } = part;
    const [canvas, cut] = makeCanvas(box.w, box.h);
    cut.drawImage(sheet, -box.x, -box.y);
    cut.globalCompositeOperation = "destination-in";
    cut.drawImage(masks[index], 0, 0);
    return { id: part.id, canvas };
  });
}

export function decodeTexture(dataUrl: string): Promise<HTMLImageElement> {
  return loadImage(dataUrl);
}
