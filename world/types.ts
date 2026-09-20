/**
 * A rig is the printed drawing cut into pieces that each move rigidly.
 *
 * Nothing here deforms. Blend skinning cannot be seamless at a joint - the weights
 * must swing from one bone to the other somewhere, and the two bones differ most
 * exactly there, so whatever ink crosses that hand-off is sheared. Rigid parts have no
 * hand-off, so there is nothing to shear.
 *
 * What makes the cuts invisible is where they are put, not how they are blended:
 * `parts` is in DRAW ORDER, back to front, and every moving part comes before the body
 * so the body paints over the cut across its top.
 *
 * Everything is in canonical texture pixels - the same 1200x800 space the capture
 * pipeline rectifies a photographed sheet into - so a vertex's UV is just its rest
 * position over the texture size, and every part samples the one shared texture.
 */

export interface RigPart {
  id: string;
  parent: string | null;
  /** Joint this part rotates about, in canonical texture pixels. */
  pivot: { x: number; y: number };
  /** Draw order, back to front. */
  z: number;
  /** The rectangle of the canonical texture this part is cut from. */
  box: { x: number; y: number; w: number; h: number };
  /**
   * Mask of the part's exact shape, the size of `box`. Two channels, two questions:
   *
   *   alpha  does this pixel belong to the part at all
   *   red    is it ever seen, or is it painted over by a part drawn later
   *
   * The shape comes from flooding out from a seed until the printed ink stops it, so
   * it follows the artist's own lines to the pixel, and then growing under whatever
   * covers it so no swing can open a gap. That second, hidden half is what `red`
   * marks: it is composited from a sheet with the printed lines filled in, because it
   * carries a copy of the belly line and a limb that swings would slide that copy out
   * into view. Shared by every dinosaur of the species; only the colouring differs.
   */
  mask: string;
}

export interface Rig {
  slug: string;
  texture: { w: number; h: number };
  /** Where the printed drawing sits inside the canonical texture. */
  artwork: { src: string; w: number; h: number; x: number; y: number };
  /** Whole-canvas layers, never sliced. */
  layers: { silhouette: string; lineart: string; shade: string };
  /** Canonical pixels from the root pivot down to the lowest point of the drawing. */
  footDrop: number;
  /**
   * Horizontal extent in canonical pixels, measured FROM THE ROOT PIVOT, which is
   * where the rig is positioned from. The pivot sits inside the body, nowhere near
   * the middle of the artwork - a Triceratops reaches much further forward, into its
   * frill and horns, than it does back into its tail. Callers that need to know when
   * the animal is off screen have to use these, not half the artwork's width.
   */
  extent: { left: number; right: number };
  /** Back to front. */
  parts: RigPart[];
}
