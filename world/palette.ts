/** Warm late-morning valley. Layers get hazier and bluer with distance. */
export const PALETTE = {
  skyTop: "#5fb0dd",
  skyMid: "#9bd3ec",
  skyHorizon: "#e4f1f4",
  sun: "#fff6d8",

  mountainFar: "#93a9c6",
  mountainNear: "#7d95b6",
  hills: "#7fa57e",
  treeline: "#4b8158",

  groundFar: "#8fb86e",
  groundNear: "#6d9a55",
  foreground: "#2d5738",

  shadow: "rgba(38, 54, 34, 0.30)",
} as const;

/** Virtual stage. Everything is authored here and scaled to fit the display. */
export const STAGE = { w: 1920, h: 1080 } as const;

/** Where land meets sky. Lanes live below it. */
export const HORIZON_Y = 560;

/**
 * Depth lanes.
 *
 * Two cues carry size: scale, and how hazy a lane is. A big dinosaur that is merely
 * scaled up reads as a close-up of a small one, so distance has to be visible in the
 * air as well as in the geometry.
 */
export interface Lane {
  /** Ground line the feet stand on. */
  baseline: number;
  scale: number;
  /** 0 = crisp and near, 1 = lost in the haze. */
  haze: number;
}

export const LANES: Lane[] = [
  { baseline: 616, scale: 0.42, haze: 0.5 },
  { baseline: 700, scale: 0.6, haze: 0.32 },
  { baseline: 840, scale: 0.82, haze: 0.15 },
  { baseline: 1010, scale: 1.05, haze: 0 },
];

/**
 * Trees stand in the third lane at a fixed height, and are the reference the whole
 * size story leans on: a Brachiosaurus clears them, a Triceratops comes up the
 * trunk. Without something of known size in frame, scale is unreadable.
 */
export const REFERENCE_TREE_HEIGHT = 300;
export const REFERENCE_TREE_LANE = 2;
