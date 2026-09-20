/**
 * The walk cycle, as plain arithmetic.
 *
 * Separated from the rig so the same curve drives the runtime, the offline preview and
 * the tests. A gait defect that only appears mid-stride is exactly the kind that
 * survives every check when the only thing anyone ever renders is the rest pose.
 *
 * The tail used to swing here and no longer does. It rides with the body, because its
 * junction has no drawn line for a cut to hide behind - see the note in the rig SVG.
 * Unknown ids simply stay still, so it costs nothing to leave that door open.
 */

export interface GaitClock {
  /** Stride phase, radians. Advances with speed. */
  phase: number;
  /** Breathing phase, radians. Advances whether or not the animal is moving. */
  breath: number;
}

/** How fast the stride phase advances, per second, at a given speed. */
export function cadence(speed: number): number {
  // Not linear in speed: a faster dinosaur takes longer strides as well as quicker
  // ones, which is what stops a fast walk reading as a scuttle. Slow overall, because
  // this is a heavy animal - a brisk cadence on a body this size reads as a scurry.
  return 1.35 + speed * 2.1;
}

export const BREATH_RATE = 0.85;

/** Diagonal gait: the front leg on one side swings with the rear leg on the other. */
function legPhase(id: string): number {
  const front = id.includes("Front");
  const near = id.includes("Near");
  return front === near ? 0 : Math.PI;
}

/**
 * Write one frame of the walk into `out`, and return the root's vertical offset.
 *
 * @param ids       bone ids in index order, as `Rig.bones`.
 * @param rootIndex index of the bone with no parent.
 * @param speed     0 = standing, 1 = normal walking pace.
 * @param out       local rotation per bone, radians. Rewritten in place.
 */
export function poseGait(
  ids: readonly string[],
  rootIndex: number,
  clock: GaitClock,
  speed: number,
  out: Float32Array,
): number {
  const { phase, breath } = clock;

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];

    if (id.startsWith("leg")) {
      // Warping the phase makes the leg linger at the back of its swing and come
      // forward more briskly, which is roughly what a planted foot does. A plain sine
      // spends equal time either side and reads as a pendulum.
      const t = phase + legPhase(id);
      const warped = t + 0.28 * Math.sin(t);
      // A real stride, now that the drawing bends rather than coming apart. The far
      // pair swings a little less, which is most of what reads as perspective.
      out[i] = Math.sin(warped) * 0.4 * speed * (id.includes("Far") ? 0.84 : 1);
    } else if (id === "head") {
      // Leads the stride a little, and keeps breathing when standing still.
      out[i] = Math.sin(phase * 0.5 + 0.9) * 0.035 * speed + Math.sin(breath) * 0.014;
    } else if (i === rootIndex) {
      // A little pitch to go with the bob. Rising and falling without any tilt reads
      // as the whole animal being winched up and down.
      out[i] = Math.sin(phase * 2 + 0.6) * 0.012 * speed;
    } else {
      out[i] = 0;
    }
  }

  // Body bob happens at twice the leg cadence: one rise per footfall, not per stride.
  // Plus a slow breath, so a standing dinosaur is never quite still.
  return Math.sin(phase * 2) * 3.2 * speed + Math.sin(breath) * 1.4;
}
