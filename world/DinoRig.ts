import { Container, Sprite, Texture } from "pixi.js";
import type { CompositedPart } from "./composite";
import type { Rig, RigPart } from "./types";

/**
 * A cutout rig animated procedurally.
 *
 * Procedural rather than a baked sprite sheet because the same body has to walk,
 * slow to a browse, turn around and amble off the edge at a speed that varies per
 * dinosaur. A sheet would need every one of those baked per species; phase-offset
 * sine curves adapt to all of it and cost nothing.
 */

export interface RigPose {
  /** 0 = standing, 1 = normal walking pace. Drives stride and cadence. */
  speed: number;
  /** 1 faces right, -1 faces left. */
  facing: 1 | -1;
}

interface Bone {
  part: RigPart;
  container: Container;
  /** Offset from the bone's own pivot to its parent's, in canonical pixels. */
  offset: { x: number; y: number };
}

/** Diagonal gait: the front leg on one side swings with the rear leg on the other. */
function legPhase(id: string): number {
  const front = id.includes("Front");
  const near = id.includes("Near");
  return front === near ? 0 : Math.PI;
}

function isLeg(id: string): boolean {
  return id.startsWith("leg");
}

export class DinoRig {
  readonly container = new Container();
  /** Canonical pixels from the root pivot down to the feet. */
  readonly footDrop: number;
  /**
   * Horizontal extent in canonical pixels, measured FROM THE ROOT PIVOT, which is
   * where the rig is positioned from. The pivot sits inside the body, nowhere near
   * the middle of the artwork - a Triceratops reaches much further forward, into its
   * frill and horns, than it does back into its tail. Callers that need to know when
   * the animal is off screen have to use these, not half the artwork's width.
   */
  readonly extent: { left: number; right: number };

  private readonly bones: Bone[] = [];
  private readonly root: Bone;
  /** Parents before children. Fixed by the skeleton, so solved once. */
  private readonly ordered: Bone[];
  private phase = Math.random() * Math.PI * 2;
  private breath = Math.random() * Math.PI * 2;

  constructor(rig: Rig, parts: CompositedPart[]) {
    const byId = new Map<string, Bone>();

    for (const { part, canvas } of parts) {
      const container = new Container();
      const sprite = new Sprite(Texture.from(canvas));
      // The sprite hangs off the pivot, so rotating the container swings the part
      // about its joint rather than about its own corner.
      sprite.position.set(part.box.x - part.pivot.x, part.box.y - part.pivot.y);
      container.addChild(sprite);

      const bone: Bone = { part, container, offset: { x: 0, y: 0 } };
      byId.set(part.id, bone);
      this.bones.push(bone);
    }

    for (const bone of this.bones) {
      const parent = bone.part.parent ? byId.get(bone.part.parent) : undefined;
      if (parent) {
        bone.offset = {
          x: bone.part.pivot.x - parent.part.pivot.x,
          y: bone.part.pivot.y - parent.part.pivot.y,
        };
      }
    }

    const root = this.bones.find((b) => !b.part.parent);
    if (!root) throw new Error(`rig ${rig.slug} has no root part`);
    this.root = root;

    // Parts are added as flat siblings in z order, not nested by bone. Nesting would
    // tie draw order to the skeleton, and the skeleton disagrees with it: the far
    // legs hang off the body but must be drawn behind it, the near legs in front.
    for (const bone of [...this.bones].sort((a, b) => a.part.z - b.part.z)) {
      this.container.addChild(bone.container);
    }

    this.footDrop =
      Math.max(...parts.map((p) => p.part.box.y + p.part.box.h)) - root.part.pivot.y;

    this.ordered = this.solveEvaluationOrder();

    this.extent = {
      left: Math.min(...parts.map((p) => p.part.box.x)) - root.part.pivot.x,
      right: Math.max(...parts.map((p) => p.part.box.x + p.part.box.w)) - root.part.pivot.x,
    };
  }

  /** Parents before children, so a bone's parent transform is always already solved. */
  private solveEvaluationOrder(): Bone[] {
    const done = new Set<string>();
    const ordered: Bone[] = [];
    let remaining = [...this.bones];

    while (remaining.length) {
      const ready = remaining.filter((b) => !b.part.parent || done.has(b.part.parent));
      if (!ready.length) break;
      for (const bone of ready) {
        ordered.push(bone);
        done.add(bone.part.id);
      }
      remaining = remaining.filter((b) => !done.has(b.part.id));
    }

    return ordered;
  }

  update(dt: number, pose: RigPose): void {
    // Cadence rises with speed but not linearly: a faster dinosaur takes longer
    // strides as well as quicker ones, which is what stops a fast walk reading as a
    // scuttle. Slow overall, because this is a heavy animal - a brisk cadence on a
    // body this size reads as a scurry.
    this.phase += dt * (1.35 + pose.speed * 2.1);
    this.breath += dt * 0.85;

    const swing = pose.speed;
    const localRotation = (bone: Bone): number => {
      const id = bone.part.id;
      if (isLeg(id)) {
        const far = id.includes("Far");
        // Warping the phase makes the leg linger at the back of its swing and come
        // forward more briskly, which is roughly what a planted foot does. A plain
        // sine spends equal time either side and reads as a pendulum.
        const t = this.phase + legPhase(id);
        const warped = t + 0.28 * Math.sin(t);
        // Shallow: a heavy animal barely lifts its feet, and a big swing on a rig
        // without a knee just looks like the leg is detaching.
        return Math.sin(warped) * 0.26 * swing * (far ? 0.84 : 1);
      }
      if (id === "tail") {
        // Slower than the gait and slightly behind it, so the tail trails the body
        // rather than beating time with the legs.
        return Math.sin(this.phase * 0.42 - 0.7) * (0.05 + 0.075 * swing) + 0.03;
      }
      if (id === "frill") {
        return Math.sin(this.phase + Math.PI) * 0.022 * swing;
      }
      if (id === "head") {
        // Leads the stride a little, and keeps breathing when standing still.
        return (
          Math.sin(this.phase * 0.5 + 0.9) * 0.035 * swing + Math.sin(this.breath) * 0.014
        );
      }
      return 0;
    };

    const world = new Map<string, { x: number; y: number; rot: number }>();

    for (const bone of this.ordered) {
      const rot = localRotation(bone);

      if (!bone.part.parent) {
        // Body bob happens at twice the leg cadence: one rise per footfall, not per
        // stride. Plus a slow breath so a standing dinosaur is never quite still.
        const bob = Math.sin(this.phase * 2) * 3.2 * swing + Math.sin(this.breath) * 1.4;
        // A little pitch with it. Rising and falling without any tilt reads as the
        // whole animal being winched up and down.
        const pitch = Math.sin(this.phase * 2 + 0.6) * 0.012 * swing;
        world.set(bone.part.id, { x: 0, y: bob, rot: rot + pitch });
      } else {
        const parent = world.get(bone.part.parent);
        if (!parent) continue;
        const cos = Math.cos(parent.rot);
        const sin = Math.sin(parent.rot);
        world.set(bone.part.id, {
          x: parent.x + bone.offset.x * cos - bone.offset.y * sin,
          y: parent.y + bone.offset.x * sin + bone.offset.y * cos,
          rot: parent.rot + rot,
        });
      }

      const solved = world.get(bone.part.id);
      if (!solved) continue;
      bone.container.position.set(solved.x, solved.y);
      bone.container.rotation = solved.rot;
    }

    this.container.scale.x = pose.facing;
  }

  destroy(): void {
    this.container.destroy({ children: true, texture: true });
  }
}
