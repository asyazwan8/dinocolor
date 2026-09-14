export interface RigBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RigPart {
  id: string;
  parent: string | null;
  /** Joint this part rotates about, in canonical texture pixels. */
  pivot: { x: number; y: number };
  /** Draw order, back to front. */
  z: number;
  /** Region of the canonical texture this part occupies. */
  box: RigBox;
  mask: string;
  lineart: string;
  /** Slice of the whole-body form shading, baked at build time. */
  shade: string;
}

export interface Rig {
  slug: string;
  texture: { w: number; h: number };
  parts: RigPart[];
}
