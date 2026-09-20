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
 * The one thing that is NOT taken from the sheet as printed is the ink inside a part's
 * hidden half. A limb reaches up under the belly, and the belly line is right there, so
 * a limb carries a copy of it; swing the limb and a fragment of that copy slides out
 * below the real belly line, which is a line moving relative to the body - the exact
 * artefact this rig exists to remove. So the hidden half is cut from a second sheet
 * with the printed lines filled in. There is no line there to come out.
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

/** Alpha in the lineart layer above which a pixel counts as printed ink. */
const INK_ALPHA = 20;
/**
 * How far the ink mask is grown before the fill.
 *
 * The lineart layer is derived from the printed artwork, but the crayon underneath it
 * comes from a photograph rectified to within a few pixels rather than exactly, so the
 * photographed line can sit slightly outside the layer's own footprint. A few pixels of
 * margin swallows that; much more starts eating the crayon beside the line.
 */
const INK_GROW = 3;
/** Below this the sheet is bare paper, not part of the drawing. */
const OPAQUE = 200;

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

/**
 * @param readBack true for a canvas whose pixels are read back rather than drawn from.
 *   It keeps the canvas off the GPU, which is what you want for the sheets and the
 *   masks and emphatically not for a cut-out that is about to become a texture.
 */
function makeCanvas(
  w: number,
  h: number,
  readBack = false,
): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: readBack });
  if (!ctx) throw new Error("2d context unavailable");
  return [canvas, ctx];
}

/** Read one whole-canvas layer back as pixels. */
function layerPixels(image: HTMLImageElement, w: number, h: number): Uint8ClampedArray {
  const [, ctx] = makeCanvas(w, h, true);
  ctx.drawImage(image, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h).data;
}

/**
 * Where the printed lines are, grown by a few pixels.
 *
 * Grown with four-neighbour passes rather than a real disc: the difference at this
 * radius is a pixel at the corners, and the line is what is being covered, not measured.
 */
function inkMask(lineart: Uint8ClampedArray, w: number, h: number): Uint8Array {
  let ink = new Uint8Array(w * h);
  for (let i = 0; i < ink.length; i++) ink[i] = lineart[i * 4 + 3] > INK_ALPHA ? 1 : 0;

  for (let pass = 0; pass < INK_GROW; pass++) {
    const grown = ink.slice();
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (ink[i] || ink[i - 1] || ink[i + 1] || ink[i - w] || ink[i + w]) grown[i] = 1;
      }
    }
    ink = grown;
  }
  return ink;
}

/**
 * The sheet with its printed lines filled in by the nearest crayon.
 *
 * A breadth-first sweep outward from every pixel that is not ink, each newly reached
 * pixel taking the colour of the one that reached it - so every covered pixel ends up
 * the colour of the nearest one that was not covered. Nearest-colour rather than a
 * blur: a six-pixel line filled from each side meets in the middle, which is what the
 * sheet would look like if the line had never been printed. A blur would drag one
 * crayon into the next and leave a smudge exactly where a limb comes out.
 */
function fillInk(
  sheet: Uint8ClampedArray,
  ink: Uint8Array,
  w: number,
  h: number,
): Uint8ClampedArray {
  const clean = new Uint8ClampedArray(sheet);
  const done = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let tail = 0;

  for (let i = 0; i < done.length; i++) {
    if (sheet[i * 4 + 3] < OPAQUE || ink[i]) continue;
    done[i] = 1;
    queue[tail++] = i;
  }

  for (let head = 0; head < tail; head++) {
    const i = queue[head];
    const x = i % w;
    for (const n of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
      if (n < 0 || n >= done.length || done[n]) continue;
      if (sheet[n * 4 + 3] < OPAQUE) continue;
      clean[n * 4] = clean[i * 4];
      clean[n * 4 + 1] = clean[i * 4 + 1];
      clean[n * 4 + 2] = clean[i * 4 + 2];
      clean[n * 4 + 3] = 255;
      done[n] = 1;
      queue[tail++] = n;
    }
  }

  return clean;
}

export async function compositeRig(
  rig: Rig,
  colouring: CanvasImageSource,
): Promise<CompositedPart[]> {
  const [silhouette, shade, lineart, ...maskImages] = await Promise.all([
    cachedImage(rig.layers.silhouette),
    cachedImage(rig.layers.shade),
    cachedImage(rig.layers.lineart),
    ...rig.parts.map((part) => cachedImage(part.mask)),
  ]);

  const { w, h } = rig.texture;
  const [, ctx] = makeCanvas(w, h, true);

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

  const sheet = ctx.getImageData(0, 0, w, h).data;
  const clean = fillInk(sheet, inkMask(layerPixels(lineart, w, h), w, h), w, h);

  return rig.parts.map((part: RigPart, index) => {
    const { box } = part;
    const [canvas, cut] = makeCanvas(box.w, box.h);

    const [, maskCtx] = makeCanvas(box.w, box.h, true);
    maskCtx.drawImage(maskImages[index], 0, 0);
    const mask = maskCtx.getImageData(0, 0, box.w, box.h).data;

    const out = cut.createImageData(box.w, box.h);
    for (let y = 0; y < box.h; y++) {
      for (let x = 0; x < box.w; x++) {
        const o = (y * box.w + x) * 4;
        if (mask[o + 3] < 128) continue;
        // Red marks the half of the part that is seen at rest. The rest is behind
        // something, and is cut from the sheet whose lines have been filled in.
        const from = mask[o] > 128 ? sheet : clean;
        const i = ((y + box.y) * w + (x + box.x)) * 4;
        out.data[o] = from[i];
        out.data[o + 1] = from[i + 1];
        out.data[o + 2] = from[i + 2];
        // Opaque either way: a hidden part is material, not a fade.
        out.data[o + 3] = 255;
      }
    }
    cut.putImageData(out, 0, 0);

    return { id: part.id, canvas };
  });
}

export function decodeTexture(dataUrl: string): Promise<HTMLImageElement> {
  return loadImage(dataUrl);
}
