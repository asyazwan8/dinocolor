import { Container, Mesh, MeshGeometry, Texture } from "pixi.js";
import { BREATH_RATE, cadence, poseGait, type GaitClock } from "./gait";
import { Skeleton, skinMesh } from "./skin";
import type { Rig } from "./types";

/**
 * A skinned dinosaur, animated procedurally.
 *
 * Procedural rather than a baked sprite sheet because the same body has to walk, slow
 * to a browse, turn around and amble off the edge at a speed that varies per dinosaur.
 * A sheet would need every one of those baked per species; phase-offset sine curves
 * adapt to all of it and cost nothing.
 *
 * One mesh, not a stack of cutouts. Cutouts partition a drawing along lines that do
 * not exist in it, so any rotation exposes the cut - the "chopped off" look. Here the
 * drawing is never divided: the bones bend a continuous sheet of triangles, so a hip
 * creases rather than coming apart.
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

  private readonly rig: Rig;
  private readonly skeleton: Skeleton;
  private readonly mesh: Mesh;
  private readonly geometry: MeshGeometry;
  private readonly texture: Texture;
  /** Local rotation per bone, rewritten each frame rather than reallocated. */
  private readonly rotation: Float32Array;
  /** Bone ids in index order, so the gait can switch on them without a lookup. */
  private readonly ids: string[];

  // Random start, so ten dinosaurs on one screen are not a chorus line.
  private readonly clock: GaitClock = {
    phase: Math.random() * Math.PI * 2,
    breath: Math.random() * Math.PI * 2,
  };

  constructor(rig: Rig, colouring: HTMLCanvasElement) {
    this.rig = rig;
    this.skeleton = new Skeleton(rig.bones);
    this.rotation = new Float32Array(rig.bones.length);
    this.ids = rig.bones.map((b) => b.id);

    this.footDrop = rig.footDrop;
    this.extent = rig.extent;

    this.geometry = new MeshGeometry({
      positions: Float32Array.from(rig.mesh.positions),
      uvs: Float32Array.from(rig.mesh.uvs),
      indices: Uint32Array.from(rig.mesh.indices),
    });

    this.texture = Texture.from(colouring);
    this.mesh = new Mesh({ geometry: this.geometry, texture: this.texture });
    this.container.addChild(this.mesh);

    // Straight into a pose, so the first frame drawn is already in root-pivot space
    // rather than in raw texture coordinates.
    this.solve(0);
  }

  /** Solve the skeleton for the current clock and rewrite the vertex buffer. */
  private solve(speed: number): void {
    const bob = poseGait(this.ids, this.skeleton.rootIndex, this.clock, speed, this.rotation);
    const bones = this.skeleton.solve(this.rotation, 0, bob);
    skinMesh(this.rig.mesh, bones, this.geometry.positions);
    this.geometry.getBuffer("aPosition").update();
  }

  update(dt: number, pose: RigPose): void {
    this.clock.phase += dt * cadence(pose.speed);
    this.clock.breath += dt * BREATH_RATE;

    this.solve(pose.speed);
    this.container.scale.x = pose.facing;
  }

  destroy(): void {
    this.container.destroy({ children: true });
    // The composited colouring belongs to this dinosaur alone, so it goes with it.
    // The shared species layers it was built from are cached elsewhere and survive.
    this.texture.destroy(true);
  }
}
