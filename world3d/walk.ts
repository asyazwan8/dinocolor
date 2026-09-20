import type { Bone } from "three";
import { BREATH_RATE, cadence, poseGait, type GaitClock } from "@/world/gait";
import type { CreatureData } from "./creature";

/**
 * The walk, driven by the same curves the 2D screen uses.
 *
 * `world/gait.ts` is plain arithmetic with no renderer in it, and its phasing is
 * already tuned - the diagonal pairs, the swing that lingers at the back of the stride,
 * the bob at twice leg cadence. None of that was wrong; only the thing being posed was.
 */
export class Walk {
  /** Random start, so several dinosaurs are not a chorus line. */
  private readonly clock: GaitClock = {
    phase: Math.random() * Math.PI * 2,
    breath: Math.random() * Math.PI * 2,
  };

  private readonly ids: string[];
  private readonly bones: Bone[];
  private readonly rootIndex: number;
  private readonly rotation: Float32Array;
  private readonly restY: number;

  constructor(data: CreatureData, bones: Map<string, Bone>) {
    this.ids = data.bones.map((bone) => bone.id);
    this.bones = this.ids.map((id) => bones.get(id)!);
    this.rootIndex = data.bones.findIndex((bone) => bone.parent === null);
    this.rotation = new Float32Array(this.ids.length);
    this.restY = this.bones[this.rootIndex].position.y;
  }

  advance(dt: number, speed: number): void {
    this.clock.phase += dt * cadence(speed);
    this.clock.breath += dt * BREATH_RATE;
    this.pose(speed);
  }

  /** Jump to one exact point in the stride, for the offline preview strip. */
  setPhase(phase: number, speed = 1): void {
    this.clock.phase = phase;
    this.clock.breath = 0;
    this.pose(speed);
  }

  private pose(speed: number): void {
    const bob = poseGait(this.ids, this.rootIndex, this.clock, speed, this.rotation);

    for (let i = 0; i < this.bones.length; i++) {
      // The gait is written in page coordinates, where y runs down the sheet. Here it
      // runs up, so a swing and a bob both change sign on the way in.
      this.bones[i].rotation.z = -this.rotation[i];
    }
    this.bones[this.rootIndex].position.y = this.restY - bob;
  }
}
