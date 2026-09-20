import { Container, Sprite, Texture } from "pixi.js";
import { BREATH_RATE, cadence, poseGait, type GaitClock } from "./gait";
import type { CompositedPart } from "./composite";
import { Skeleton } from "./skeleton";
import type { Rig } from "./types";

/**
 * A dinosaur as a stack of rigid cut-outs, animated procedurally.
 *
 * Procedural rather than a baked sprite sheet because the same body has to walk, slow
 * to a browse, turn around and amble off the edge at a speed that varies per dinosaur.
 * A sheet would need every one of those baked per species; phase-offset sine curves
 * adapt to all of it and cost nothing.
 *
 * Nothing here deforms the drawing. Four earlier attempts bent it with blend skinning
 * and each produced a different artefact, because a joint must hand over from one bone
 * to the next somewhere, and the two differ most exactly there - so whatever ink
 * crosses the hand-off is sheared. Rigid parts have no hand-off.
 *
 * What makes the cuts invisible is the ORDER. `rig.parts` runs back to front and every
 * limb comes before the body, so the cut across a limb's top is painted over at any
 * angle; each limb's cut-out carries on well past that cut, buried inside the torso,
 * so no swing can open a gap either. The one part drawn in FRONT of the body is the
 * head, and that is allowed only because the frill gives it a real drawn outline.
 *
 * Per frame this costs six transforms.
 */

export interface RigPose {
  /** 0 = standing, 1 = normal walking pace. Drives stride and cadence. */
  speed: number;
  /** 1 faces right, -1 faces left. */
  facing: 1 | -1;
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

  private readonly skeleton: Skeleton;
  private readonly textures: Texture[] = [];
  private readonly holders: Container[];
  /** Local rotation per part, rewritten each frame rather than reallocated. */
  private readonly rotation: Float32Array;
  /** Part ids in index order, so the gait can switch on them without a lookup. */
  private readonly ids: string[];

  // Random start, so ten dinosaurs on one screen are not a chorus line.
  private readonly clock: GaitClock = {
    phase: Math.random() * Math.PI * 2,
    breath: Math.random() * Math.PI * 2,
  };

  constructor(rig: Rig, cutouts: CompositedPart[]) {
    this.skeleton = new Skeleton(rig.parts);
    this.rotation = new Float32Array(rig.parts.length);
    this.ids = rig.parts.map((p) => p.id);
    this.footDrop = rig.footDrop;
    this.extent = rig.extent;

    // Added in rig order, which is back to front. Flat siblings rather than nested by
    // parent, because the skeleton disagrees with the draw order: the legs hang off
    // the body but have to be drawn behind it.
    this.holders = rig.parts.map((part, index) => {
      const texture = Texture.from(cutouts[index].canvas);
      this.textures.push(texture);

      const sprite = new Sprite(texture);
      // The sprite hangs off the pivot, so turning the holder swings the part about
      // its joint rather than about its own corner.
      sprite.position.set(part.box.x - part.pivot.x, part.box.y - part.pivot.y);

      const holder = new Container();
      holder.addChild(sprite);
      this.container.addChild(holder);
      return holder;
    });

    this.solve(0);
  }

  /** Solve the skeleton for the current clock and place every part. */
  private solve(speed: number): void {
    const bob = poseGait(this.ids, this.skeleton.rootIndex, this.clock, speed, this.rotation);
    const solved = this.skeleton.solve(this.rotation, 0, bob);

    for (let i = 0; i < this.holders.length; i++) {
      this.holders[i].position.set(solved.x[i], solved.y[i]);
      this.holders[i].rotation = solved.rot[i];
    }
  }

  update(dt: number, pose: RigPose): void {
    this.clock.phase += dt * cadence(pose.speed);
    this.clock.breath += dt * BREATH_RATE;

    this.solve(pose.speed);
    this.container.scale.x = pose.facing;
  }

  destroy(): void {
    this.container.destroy({ children: true });
    // The cut-outs belong to this dinosaur alone, so they go with it. The masks they
    // were cut with are cached elsewhere and survive.
    for (const texture of this.textures) texture.destroy(true);
  }
}
