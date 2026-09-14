/**
 * Soft painterly valley: pale layered blues receding into haze, rolling greens,
 * conifers with yellow ginkgo among them, a flower meadow up front.
 *
 * The palette is deliberately low-contrast and high-key. The dinosaurs carry a
 * child's crayon, which is saturated and dark, so the world has to sit back and let
 * them read - a scene painted at the same intensity would swallow them.
 */
export const PALETTE = {
  skyTop: "#a3d2ef",
  skyMid: "#cbe6f4",
  skyHorizon: "#fdf4de",
  sun: "#fff6dc",
  cloud: "#ffffff",
  cloudWarm: "#ffe8d8",

  /** Farthest to nearest. Each band steps toward green and away from haze. */
  mountains: ["#b9cee4", "#a3bedb", "#8fb0d2", "#86aec3"],
  hills: ["#8fbf94", "#9ecb84", "#aed68c"],

  conifer: "#4d8b5c",
  coniferFar: "#7ba98a",
  ginkgo: "#efd648",
  ginkgoFar: "#e7dc94",
  trunk: "#8a6b4f",

  groundFar: "#b6d98c",
  groundNear: "#a5cd6e",
  meadow: "#bcdc7e",
  flowerPink: "#f3a8c2",
  flowerWhite: "#fff6f2",
  flowerOrange: "#f6ad55",

  shadow: "rgba(64, 92, 56, 0.26)",
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
  { baseline: 724, scale: 0.42, haze: 0.42 },
  { baseline: 802, scale: 0.6, haze: 0.26 },
  { baseline: 892, scale: 0.82, haze: 0.12 },
  { baseline: 1012, scale: 1.05, haze: 0 },
];

/**
 * Trees are the reference the whole size story leans on: a Brachiosaurus clears
 * them, a Triceratops comes up the trunk. Without something of known size in frame,
 * scale is unreadable.
 *
 * The painted backdrop supplies its own stand of trees, so these are only drawn when
 * falling back to procedural scenery. Drawing both would double them up.
 */
export const REFERENCE_TREE_HEIGHT = 300;
export const REFERENCE_TREE_LANE = 2;

/** The painted valley, and the strip of it redrawn in front of the dinosaurs. */
export const BACKDROP_SRC = "/assets/world/valley.webp";
export const FOREGROUND_STRIP = 96;
/**
 * How much of the strip's upper edge is faded out. A crop has a perfectly straight
 * top border, and the nearest lane's legs cross it; undimmed it reads as a horizontal
 * cut through the animal rather than as grass in front of it. Most of the strip, so
 * the transition is a bank of grass and not a visible band.
 */
export const FOREGROUND_FEATHER = 62;

/** Blend two hex colours. Used to fade distant layers into the haze. */
export function mixHex(from: string, to: string, t: number): string {
  const parse = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [r1, g1, b1] = parse(from);
  const [r2, g2, b2] = parse(to);
  const mix = (a: number, b: number) => Math.round(a + (b - a) * t);
  return `rgb(${mix(r1, r2)}, ${mix(g1, g2)}, ${mix(b1, b2)})`;
}
