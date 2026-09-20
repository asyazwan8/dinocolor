import type { Rig } from "./types";

/**
 * The skeleton: a tree of pivots, solved into world transforms.
 *
 * Deliberately free of Pixi and of the DOM, so the part of the rig that can be wrong
 * in ways nobody notices until a limb swings the wrong way is testable as plain
 * arithmetic rather than only by looking at a screen.
 *
 * Rotation and translation only - no scale, no shear - because every part is rigid.
 * That is the whole point of this rig: there is no per-vertex blending left to do, so
 * each part is one transform and the GPU applies it.
 */

/** Solved world transforms, one entry per part, indexed as `Rig.parts` is. */
export interface SolvedParts {
  x: Float32Array;
  y: Float32Array;
  /** Accumulated rotation, radians - what a container's `rotation` wants. */
  rot: Float32Array;
}

export class Skeleton {
  readonly count: number;
  readonly rootIndex: number;
  /** Part id -> index, for callers that pose by name. */
  readonly indexOf: ReadonlyMap<string, number>;

  private readonly parent: Int32Array;
  /** Parents before children, so a part's parent is always already solved. */
  private readonly order: Int32Array;
  /** Offset from the parent's pivot to this part's, at rest. */
  private readonly ox: Float32Array;
  private readonly oy: Float32Array;

  private readonly solved: SolvedParts;

  constructor(parts: Pick<Rig["parts"][number], "id" | "parent" | "pivot">[]) {
    this.count = parts.length;

    const indexOf = new Map<string, number>();
    parts.forEach((part, i) => indexOf.set(part.id, i));
    this.indexOf = indexOf;

    this.parent = new Int32Array(this.count);
    this.ox = new Float32Array(this.count);
    this.oy = new Float32Array(this.count);

    let root = -1;
    parts.forEach((part, i) => {
      const p = part.parent === null ? -1 : indexOf.get(part.parent) ?? -1;
      this.parent[i] = p;
      if (p < 0) {
        if (root < 0) root = i;
      } else {
        this.ox[i] = part.pivot.x - parts[p].pivot.x;
        this.oy[i] = part.pivot.y - parts[p].pivot.y;
      }
    });
    if (root < 0) throw new Error("skeleton has no root part");
    this.rootIndex = root;

    this.order = this.evaluationOrder();

    this.solved = {
      x: new Float32Array(this.count),
      y: new Float32Array(this.count),
      rot: new Float32Array(this.count),
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
   * The space is the ROOT PIVOT's: at rest with no translation, part zero sits at the
   * origin. That is the same space `Rig.extent` and `Rig.footDrop` are measured in,
   * which is what lets the world position a dinosaur by a single container.
   *
   * @param rotation local rotation per part, radians, indexed as `Rig.parts`.
   * @param rootX    translation applied to the root, canonical pixels.
   */
  solve(rotation: ArrayLike<number>, rootX = 0, rootY = 0): SolvedParts {
    const { x, y, rot } = this.solved;

    for (let k = 0; k < this.order.length; k++) {
      const i = this.order[k];
      const p = this.parent[i];

      if (p < 0) {
        x[i] = rootX;
        y[i] = rootY;
        rot[i] = rotation[i] ?? 0;
        continue;
      }

      // The parent's rotation carries this part's pivot around with it; this part's
      // own rotation is then composed on top for its children and its vertices.
      const c = Math.cos(rot[p]);
      const s = Math.sin(rot[p]);
      x[i] = x[p] + this.ox[i] * c - this.oy[i] * s;
      y[i] = y[p] + this.ox[i] * s + this.oy[i] * c;
      rot[i] = rot[p] + (rotation[i] ?? 0);
    }

    return this.solved;
  }
}
