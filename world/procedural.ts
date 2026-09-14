import {
  BACKDROP_SRC,
  HORIZON_Y,
  LANES,
  PALETTE,
  REFERENCE_TREE_HEIGHT,
  REFERENCE_TREE_LANE,
  STAGE,
  mixHex,
} from "./palette";

/**
 * The world, drawn in code.
 *
 * Magnific art for these layers has to be fetched and committed by hand, so the
 * renderer cannot depend on it being present. These procedural layers are the
 * fallback, and they are built to be good enough to run an installation on: the
 * painted art drops into the same slots when it arrives.
 */

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x9e3779b9) >>> 0;
    let t = Math.imul(a ^ (a >>> 16), 0x21f0aaad);
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97);
    return ((t ^= t >>> 15) >>> 0) / 4294967296;
  };
}

function layer(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  return [canvas, ctx];
}

export function makeSky(): HTMLCanvasElement {
  const [canvas, ctx] = layer(STAGE.w, STAGE.h);

  const sky = ctx.createLinearGradient(0, 0, 0, HORIZON_Y + 60);
  sky.addColorStop(0, PALETTE.skyTop);
  sky.addColorStop(0.5, PALETTE.skyMid);
  sky.addColorStop(1, PALETTE.skyHorizon);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, STAGE.w, HORIZON_Y + 60);

  // A broad, low-contrast glow rather than a disc: the reference has warmth spilling
  // across a whole corner of the sky, not a sun you can point at.
  const glow = ctx.createRadialGradient(1480, 150, 30, 1480, 150, 680);
  glow.addColorStop(0, PALETTE.sun);
  glow.addColorStop(0.55, "rgba(255,240,205,0.35)");
  glow.addColorStop(1, "rgba(255,246,220,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, STAGE.w, HORIZON_Y + 60);

  return canvas;
}

/** Twice stage width so it can scroll and wrap without a visible seam. */
export function makeClouds(): HTMLCanvasElement {
  const [canvas, ctx] = layer(STAGE.w * 2, 480);
  const rand = seeded(7);

  // Many soft overlapping ellipses at low alpha, rather than a few hard ones. Hard
  // edges read as cartoon against a painted sky; these build up into a mass.
  for (let i = 0; i < 22; i++) {
    const cx = rand() * canvas.width;
    const cy = 60 + rand() * 260;
    const scale = 0.8 + rand() * 1.5;
    const warm = rand() < 0.28;
    ctx.fillStyle = warm
      ? `rgba(255,236,224,${0.09 + rand() * 0.11})`
      : `rgba(255,255,255,${0.13 + rand() * 0.17})`;

    for (let puff = 0; puff < 11; puff++) {
      const t = puff / 10;
      const px = cx + (t - 0.5) * 260 * scale + (rand() - 0.5) * 40;
      const py = cy + Math.sin(t * Math.PI) * -26 * scale + (rand() - 0.5) * 18;
      const r = (40 + Math.sin(t * Math.PI) * 52) * scale;
      ctx.beginPath();
      ctx.ellipse(px, py, r, r * 0.62, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  return canvas;
}

function ridge(
  ctx: CanvasRenderingContext2D,
  baseY: number,
  amplitude: number,
  roughness: number,
  colour: string,
  seed: number,
  step = 26,
): void {
  const rand = seeded(seed);
  ctx.beginPath();
  ctx.moveTo(0, STAGE.h);
  ctx.lineTo(0, baseY);

  let y = baseY;
  for (let x = 0; x <= STAGE.w; x += step) {
    y += (rand() - 0.5) * roughness;
    y = Math.max(baseY - amplitude, Math.min(baseY + amplitude * 0.35, y));
    ctx.lineTo(x, y);
  }

  ctx.lineTo(STAGE.w, STAGE.h);
  ctx.closePath();
  ctx.fillStyle = colour;
  ctx.fill();
}

/**
 * Four bands, each paler and further into the haze than the one in front.
 *
 * Depth here comes from value and temperature, not outline. A single silhouette row
 * reads as a wall however jagged it is; a stack of receding tones reads as distance,
 * which is the whole job of this layer.
 */
export function makeMountains(): HTMLCanvasElement {
  const [canvas, ctx] = layer(STAGE.w, STAGE.h);

  PALETTE.mountains.forEach((colour, i) => {
    const depth = 1 - i / (PALETTE.mountains.length - 1);
    ridge(
      ctx,
      HORIZON_Y - 74 + i * 24,
      112 - i * 18,
      52 - i * 9,
      // Fade the far bands toward the horizon colour so they sit back in the air.
      mixHex(colour, PALETTE.skyHorizon, depth * 0.42),
      17 + i * 13,
      i < 2 ? 22 : 30,
    );
  });

  return canvas;
}

export function makeHills(): HTMLCanvasElement {
  const [canvas, ctx] = layer(STAGE.w, STAGE.h);

  PALETTE.hills.forEach((colour, i) => {
    ridge(ctx, HORIZON_Y - 28 + i * 24, 62 - i * 14, 22 - i * 5, colour, 61 + i * 17, 34);
  });

  return canvas;
}

function conifer(
  ctx: CanvasRenderingContext2D,
  x: number,
  baseY: number,
  height: number,
  colour: string,
  trunk: string,
): void {
  const width = height * 0.42;

  ctx.fillStyle = trunk;
  ctx.fillRect(x - height * 0.026, baseY - height * 0.2, height * 0.052, height * 0.2);

  ctx.fillStyle = colour;
  for (let tier = 0; tier < 5; tier++) {
    const t = tier / 5;
    const tierY = baseY - height * (0.16 + t * 0.78);
    const half = (width / 2) * (1 - t * 0.66);
    ctx.beginPath();
    ctx.moveTo(x, tierY - height * 0.22);
    ctx.quadraticCurveTo(x + half * 0.8, tierY - height * 0.04, x + half, tierY);
    ctx.lineTo(x - half, tierY);
    ctx.quadraticCurveTo(x - half * 0.8, tierY - height * 0.04, x, tierY - height * 0.22);
    ctx.closePath();
    ctx.fill();
  }
}

/** Rounded clustered canopy — the yellow accent that gives the valley its character. */
function ginkgo(
  ctx: CanvasRenderingContext2D,
  x: number,
  baseY: number,
  height: number,
  colour: string,
  trunk: string,
  rand: () => number,
): void {
  ctx.strokeStyle = trunk;
  ctx.lineWidth = Math.max(2, height * 0.04);
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x, baseY);
  ctx.lineTo(x, baseY - height * 0.56);
  ctx.stroke();

  // Two passes: a shaded mass, then the lit colour offset up and left. A single flat
  // fill reads as a blob on a stick, because unlike the conifer's tiers there is no
  // internal structure to catch the light.
  const canopyY = baseY - height * 0.74;
  const blobs: Array<[number, number]> = [];
  for (let blob = 0; blob < 10; blob++) {
    const angle = (blob / 10) * Math.PI * 2;
    const spread = height * 0.14;
    blobs.push([
      x + Math.cos(angle) * spread * (0.45 + rand() * 0.6),
      canopyY + Math.sin(angle) * spread * 0.7 * (0.45 + rand() * 0.6),
    ]);
  }

  for (const [pass, tint] of [[0, mixHex(colour, PALETTE.conifer, 0.34)], [1, colour]] as const) {
    ctx.fillStyle = tint;
    const dx = pass === 0 ? height * 0.022 : -height * 0.014;
    const dy = pass === 0 ? height * 0.026 : -height * 0.018;
    for (const [px, py] of blobs) {
      ctx.beginPath();
      ctx.ellipse(px + dx, py + dy, height * 0.095, height * 0.085, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/**
 * The treeline doubles as the ruler. Trees in the reference lane are all exactly
 * REFERENCE_TREE_HEIGHT, so a viewer can read a dinosaur's size against them.
 */
export function makeTreeline(): HTMLCanvasElement {
  const [canvas, ctx] = layer(STAGE.w, STAGE.h);
  const rand = seeded(97);
  const referenceBase = LANES[REFERENCE_TREE_LANE].baseline;

  // Distant band, small and hazed, sitting along the horizon.
  for (let i = 0; i < 54; i++) {
    const x = rand() * STAGE.w;
    const height = 48 + rand() * 30;
    if (rand() < 0.26) {
      ginkgo(ctx, x, HORIZON_Y + 16, height, PALETTE.ginkgoFar, PALETTE.trunk, rand);
    } else {
      conifer(ctx, x, HORIZON_Y + 16, height, PALETTE.coniferFar, PALETTE.trunk);
    }
  }

  // Reference stand: uniform in height because that is the whole point of it, but
  // grouped towards the edges. An evenly spaced row reads as a fence and walls off
  // the middle of the stage, which is where the dinosaurs need to be seen.
  const clumps = [0.04, 0.14, 0.33, 0.73, 0.88, 0.97];
  clumps.forEach((t, i) => {
    const x = t * STAGE.w + (rand() - 0.5) * 60;
    if (i % 3 === 1) {
      ginkgo(ctx, x, referenceBase, REFERENCE_TREE_HEIGHT, PALETTE.ginkgo, PALETTE.trunk, rand);
    } else {
      conifer(ctx, x, referenceBase, REFERENCE_TREE_HEIGHT, PALETTE.conifer, PALETTE.trunk);
    }
  });

  return canvas;
}

export function makeGround(): HTMLCanvasElement {
  const [canvas, ctx] = layer(STAGE.w, STAGE.h);

  const grass = ctx.createLinearGradient(0, HORIZON_Y, 0, STAGE.h);
  grass.addColorStop(0, PALETTE.groundFar);
  grass.addColorStop(0.55, PALETTE.meadow);
  grass.addColorStop(1, PALETTE.groundNear);
  ctx.fillStyle = grass;
  ctx.fillRect(0, HORIZON_Y, STAGE.w, STAGE.h - HORIZON_Y);

  // Faint banding along the lane baselines gives the eye something to read depth from.
  const rand = seeded(131);
  for (const lane of LANES) {
    ctx.fillStyle = "rgba(255,255,255,0.07)";
    ctx.fillRect(0, lane.baseline - 7, STAGE.w, 4);
    for (let i = 0; i < 110; i++) {
      const x = rand() * STAGE.w;
      const y = lane.baseline - rand() * 30;
      ctx.fillStyle = `rgba(126,164,92,${0.12 + rand() * 0.16})`;
      ctx.fillRect(x, y, 2 + rand() * 6, 1 + rand() * 2);
    }
  }

  return canvas;
}

/**
 * A flower meadow, drawn in front of the dinosaurs.
 *
 * Low and light on purpose. The near lane's feet land around y=1010, so tall dark
 * grass here swallows the biggest dinosaurs instead of framing them.
 */
export function makeForeground(): HTMLCanvasElement {
  const [canvas, ctx] = layer(STAGE.w, STAGE.h);
  const rand = seeded(211);

  for (let i = 0; i < 26; i++) {
    const x = rand() * STAGE.w;
    const baseY = STAGE.h + 16;
    const height = 56 + rand() * 78;
    ctx.strokeStyle = `rgba(122,168,84,${0.55 + rand() * 0.35})`;
    ctx.lineWidth = 5 + rand() * 5;
    ctx.lineCap = "round";
    for (let blade = 0; blade < 5; blade++) {
      const lean = (blade - 2) * (14 + rand() * 12);
      ctx.beginPath();
      ctx.moveTo(x, baseY);
      ctx.quadraticCurveTo(x + lean * 0.5, baseY - height * 0.6, x + lean, baseY - height);
      ctx.stroke();
    }
  }

  const petals = [PALETTE.flowerPink, PALETTE.flowerWhite, PALETTE.flowerOrange];
  for (let i = 0; i < 90; i++) {
    const x = rand() * STAGE.w;
    const y = STAGE.h - rand() * 120;
    const r = 4 + rand() * 5;
    ctx.fillStyle = petals[Math.floor(rand() * petals.length)];
    for (let petal = 0; petal < 5; petal++) {
      const angle = (petal / 5) * Math.PI * 2;
      ctx.beginPath();
      ctx.ellipse(x + Math.cos(angle) * r, y + Math.sin(angle) * r * 0.8, r * 0.7, r * 0.55, angle, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  return canvas;
}

/**
 * Load the painted valley, or report that it is absent.
 *
 * The renderer must not assume the painting is there: it is committed art, and a
 * checkout without it still has to run. A null here simply means the procedural
 * layers above are used instead.
 */
export function loadBackdrop(src: string = BACKDROP_SRC): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}
