/**
 * A rig is one continuous drawing plus a skeleton that bends it.
 *
 * Nothing here slices the artwork. The mesh below covers the whole silhouette, each
 * vertex is bound to a few bones, and bending the bones bends the drawing as a single
 * sheet - which is what makes a seam impossible rather than merely well hidden.
 *
 * Everything is in canonical texture pixels: the same 1200x800 space the capture
 * pipeline rectifies a photographed sheet into, so a vertex's UV is just its rest
 * position over the texture size.
 */

export interface RigBone {
  id: string;
  parent: string | null;
  /** Joint this bone rotates about, in canonical texture pixels. */
  pivot: { x: number; y: number };
}

export interface RigMesh {
  vertexCount: number;
  /** Bones allowed to influence one vertex. Every vertex carries exactly this many. */
  influences: number;
  /** Rest positions, 2 per vertex, in canonical texture pixels. */
  positions: number[];
  /** 2 per vertex, rest position over texture size. */
  uvs: number[];
  indices: number[];
  /** `influences` per vertex, indexing into `Rig.bones`. */
  boneIndex: number[];
  /** `influences` per vertex, summing to 1. Unused slots are 0. */
  boneWeight: number[];
  /**
   * 2 per influence: the vertex's rest position relative to that bone's pivot.
   * Precomputed so the runtime never subtracts a pivot per vertex per frame.
   */
  offsets: number[];
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
  bones: RigBone[];
  mesh: RigMesh;
}
