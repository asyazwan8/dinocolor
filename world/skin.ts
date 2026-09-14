import type { Rig, RigMesh } from "./types";

/**
 * Linear blend skinning for a 2D skeleton.
 *
 * Deliberately free of Pixi and of the DOM: this is the part that can be wrong in
 * ways nobody sees until a leg detaches mid-stride, so it has to be testable as plain
 * arithmetic rather than only by looking at a screen.
 *
 * Rotation and translation only - no scale, no shear - so a bone is four multiplies
 * and four adds per influence, and a vertex is that times three.
 */

/** Solved world transforms, one entry per bone, indexed as `Rig.bones` is. */
export interface SolvedBones {
  x: Float32Array;
  y: Float32Array;
  cos: Float32Array;
  sin: Float32Array;
}

export class Skeleton {
  readonly count: number;
  readonly rootIndex: number;
  /** Bone id -> index, for callers that pose by name. */
  readonly indexOf: ReadonlyMap<string, number>;

  private readonly parent: Int32Array;
  /** Parents before children, so a bone's parent is always already solved. */
  private readonly order: Int32Array;
  /** Offset from the parent's pivot to this bone's, at rest. */
  private readonly ox: Float32Array;
  private readonly oy: Float32Array;

  private readonly solved: SolvedBones;

  constructor(bones: Rig["bones"]) {
    this.count = bones.length;

    const indexOf = new Map<string, number>();
    bones.forEach((bone, i) => indexOf.set(bone.id, i));
    this.indexOf = indexOf;

    this.parent = new Int32Array(this.count);
    this.ox = new Float32Array(this.count);
    this.oy = new Float32Array(this.count);

    let root = -1;
    bones.forEach((bone, i) => {
      const p = bone.parent === null ? -1 : indexOf.get(bone.parent) ?? -1;
      this.parent[i] = p;
      if (p < 0) {
        if (root < 0) root = i;
      } else {
        this.ox[i] = bone.pivot.x - bones[p].pivot.x;
        this.oy[i] = bone.pivot.y - bones[p].pivot.y;
      }
    });
    if (root < 0) throw new Error("skeleton has no root bone");
    this.rootIndex = root;

    this.order = this.evaluationOrder();

    this.solved = {
      x: new Float32Array(this.count),
      y: new Float32Array(this.count),
      cos: new Float32Array(this.count),
      sin: new Float32Array(this.count),
    };
  }

  private evaluationOrder(): Int32Array {
    const done = new Uint8Array(this.count);
    const order: number[] = [];

    // A bounded number of sweeps rather than recursion, so a malformed skeleton with
    // a parent cycle stops instead of blowing the stack.
    for (let sweep = 0; sweep < this.count && order.length < this.count; sweep++) {
      for (let i = 0; i < this.count; i++) {
        if (done[i]) continue;
        const p = this.parent[i];
        if (p >= 0 && !done[p]) continue;
        done[i] = 1;
        order.push(i);
      }
    }
    if (order.length !== this.count) throw new Error("skeleton has a parent cycle");

    return Int32Array.from(order);
  }

  /**
   * Walk the hierarchy and produce world transforms.
   *
   * The space is the ROOT PIVOT's: at rest with no translation, bone zero sits at the
   * origin, so a skinned vertex comes out as `restPosition - rootPivot`. That is the
   * same space `Rig.extent` and `Rig.footDrop` are measured in, which is what lets the
   * world position a dinosaur by a single container.
   *
   * @param rotation local rotation per bone, radians, indexed as `Rig.bones`.
   * @param rootX    translation applied to the root, canonical pixels.
   */
  solve(rotation: ArrayLike<number>, rootX = 0, rootY = 0): SolvedBones {
    const { x, y, cos, sin } = this.solved;

    for (let k = 0; k < this.order.length; k++) {
      const i = this.order[k];
      const p = this.parent[i];

      if (p < 0) {
        x[i] = rootX;
        y[i] = rootY;
        const r = rotation[i] ?? 0;
        cos[i] = Math.cos(r);
        sin[i] = Math.sin(r);
        continue;
      }

      // The parent's rotation carries this bone's pivot around with it; this bone's
      // own rotation is then composed on top for its children and its vertices.
      const pc = cos[p];
      const ps = sin[p];
      x[i] = x[p] + this.ox[i] * pc - this.oy[i] * ps;
      y[i] = y[p] + this.ox[i] * ps + this.oy[i] * pc;

      // Composing the angles through cos/sin of the parent's total avoids carrying a
      // separate angle array, and keeps this to the two trig calls per bone.
      const r = rotation[i] ?? 0;
      const rc = Math.cos(r);
      const rs = Math.sin(r);
      cos[i] = pc * rc - ps * rs;
      sin[i] = ps * rc + pc * rs;
    }

    return this.solved;
  }
}

/**
 * Blend every vertex by its influences and write the result into `out`.
 *
 * `out` is the geometry's own position buffer, rewritten in place: this runs for ten
 * dinosaurs every frame, so it allocates nothing.
 */
export function skinMesh(mesh: RigMesh, bones: SolvedBones, out: Float32Array): void {
  const { vertexCount, influences, boneIndex, boneWeight, offsets } = mesh;
  const { x: bx, y: by, cos: bc, sin: bs } = bones;

  for (let v = 0; v < vertexCount; v++) {
    let px = 0;
    let py = 0;

    for (let i = 0; i < influences; i++) {
      const k = v * influences + i;
      const w = boneWeight[k];
      // Padding slots are exactly zero, and a vertex owned outright by one bone has
      // two of them. Skipping is worth it: that is the common case.
      if (w === 0) continue;

      const b = boneIndex[k];
      const ox = offsets[k * 2];
      const oy = offsets[k * 2 + 1];
      const c = bc[b];
      const s = bs[b];

      px += w * (bx[b] + ox * c - oy * s);
      py += w * (by[b] + ox * s + oy * c);
    }

    out[v * 2] = px;
    out[v * 2 + 1] = py;
  }
}
