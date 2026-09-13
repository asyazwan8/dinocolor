import { HORIZON_Y, LANES, PALETTE, REFERENCE_TREE_HEIGHT, REFERENCE_TREE_LANE, STAGE } from "./palette";

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

  const sky = ctx.createLinearGradient(0, 0, 0, HORIZON_Y + 40);
  sky.addColorStop(0, PALETTE.skyTop);
  sky.addColorStop(0.55, PALETTE.skyMid);
  sky.addColorStop(1, PALETTE.skyHorizon);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, STAGE.w, HORIZON_Y + 40);

  const glow = ctx.createRadialGradient(1420, 200, 20, 1420, 200, 460);
  glow.addColorStop(0, PALETTE.sun);
  glow.addColorStop(1, "rgba(255,246,216,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, STAGE.w, HORIZON_Y + 40);

  return canvas;
}

/** Twice stage width so it can scroll and wrap without a visible seam. */
export function makeClouds(): HTMLCanvasElement {
  const [canvas, ctx] = layer(STAGE.w * 2, 460);
  const rand = seeded(7);

  for (let i = 0; i < 26; i++) {
    const cx = rand() * canvas.width;
    const cy = 40 + rand() * 300;
    const scale = 0.5 + rand() * 1.3;
    ctx.fillStyle = `rgba(255,255,255,${0.2 + rand() * 0.35})`;
    for (let puff = 0; puff < 6; puff++) {
      const px = cx + (puff - 2.5) * 44 * scale + rand() * 26;
      const py = cy + Math.sin(puff) * 14 * scale;
      ctx.beginPath();
      ctx.ellipse(px, py, 68 * scale, 30 * scale, 0, 0, Math.PI * 2);
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
): void {
  const rand = seeded(seed);
  ctx.beginPath();
  ctx.moveTo(0, STAGE.h);
  ctx.lineTo(0, baseY);

  let y = baseY;
  for (let x = 0; x <= STAGE.w; x += 28) {
    y += (rand() - 0.5) * roughness;
    y = Math.max(baseY - amplitude, Math.min(baseY + amplitude * 0.35, y));
    ctx.lineTo(x, y);
  }

  ctx.lineTo(STAGE.w, STAGE.h);
  ctx.closePath();
  ctx.fillStyle = colour;
  ctx.fill();
}

export function makeMountains(): HTMLCanvasElement {
  const [canvas, ctx] = layer(STAGE.w, STAGE.h);
  ridge(ctx, HORIZON_Y - 96, 150, 68, PALETTE.mountainFar, 21);
  ridge(ctx, HORIZON_Y - 40, 96, 44, PALETTE.mountainNear, 33);
  return canvas;
}

export function makeHills(): HTMLCanvasElement {
  const [canvas, ctx] = layer(STAGE.w, STAGE.h);
  ridge(ctx, HORIZON_Y + 6, 44, 16, PALETTE.hills, 51);
  return canvas;
}

function conifer(
  ctx: CanvasRenderingContext2D,
  x: number,
  baseY: number,
  height: number,
  colour: string,
): void {
  const width = height * 0.44;
  ctx.fillStyle = colour;

  ctx.fillRect(x - height * 0.035, baseY - height * 0.22, height * 0.07, height * 0.22);

  for (let tier = 0; tier < 4; tier++) {
    const t = tier / 4;
    const tierY = baseY - height * (0.18 + t * 0.74);
    const half = (width / 2) * (1 - t * 0.62);
    ctx.beginPath();
    ctx.moveTo(x, tierY - height * 0.24);
    ctx.lineTo(x + half, tierY);
    ctx.lineTo(x - half, tierY);
    ctx.closePath();
    ctx.fill();
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

  // Distant band, small and hazy, sitting on the horizon.
  for (let i = 0; i < 46; i++) {
    const x = rand() * STAGE.w;
    conifer(ctx, x, HORIZON_Y + 14, 54 + rand() * 26, "rgba(96,140,108,0.78)");
  }

  // Reference stand: uniform in height because that is the whole point of it, but
  // grouped in clumps towards the edges. An evenly spaced row reads as a fence and
  // walls off the middle of the stage, which is where the dinosaurs need to be seen.
  const clumps = [0.05, 0.15, 0.34, 0.72, 0.88, 0.96];
  for (const t of clumps) {
    const x = t * STAGE.w + (rand() - 0.5) * 60;
    conifer(ctx, x, referenceBase, REFERENCE_TREE_HEIGHT, PALETTE.treeline);
  }

  return canvas;
}

export function makeGround(): HTMLCanvasElement {
  const [canvas, ctx] = layer(STAGE.w, STAGE.h);

  const grass = ctx.createLinearGradient(0, HORIZON_Y, 0, STAGE.h);
  grass.addColorStop(0, PALETTE.groundFar);
  grass.addColorStop(1, PALETTE.groundNear);
  ctx.fillStyle = grass;
  ctx.fillRect(0, HORIZON_Y, STAGE.w, STAGE.h - HORIZON_Y);

  // Faint bands along the lane baselines give the eye something to read depth from.
  const rand = seeded(131);
  for (const lane of LANES) {
    ctx.fillStyle = `rgba(255,255,255,0.05)`;
    ctx.fillRect(0, lane.baseline - 6, STAGE.w, 3);
    for (let i = 0; i < 90; i++) {
      const x = rand() * STAGE.w;
      const y = lane.baseline - rand() * 28;
      ctx.fillStyle = `rgba(60,96,54,${0.10 + rand() * 0.16})`;
      ctx.fillRect(x, y, 2 + rand() * 5, 1 + rand() * 2);
    }
  }

  return canvas;
}

export function makeForeground(): HTMLCanvasElement {
  const [canvas, ctx] = layer(STAGE.w, STAGE.h);
  const rand = seeded(211);

  // Low and sparse: the near lane's feet land around y=1010, so tall grass here
  // would swallow the biggest dinosaurs rather than framing them.
  for (let i = 0; i < 16; i++) {
    const x = rand() * STAGE.w;
    const baseY = STAGE.h + 14;
    const height = 70 + rand() * 90;
    ctx.strokeStyle = PALETTE.foreground;
    ctx.lineWidth = 7 + rand() * 7;
    ctx.lineCap = "round";
    for (let blade = 0; blade < 6; blade++) {
      const lean = (blade - 2.5) * (14 + rand() * 12);
      ctx.beginPath();
      ctx.moveTo(x, baseY);
      ctx.quadraticCurveTo(x + lean * 0.5, baseY - height * 0.6, x + lean, baseY - height);
      ctx.stroke();
    }
  }

  for (let i = 0; i < 5; i++) {
    const x = rand() * STAGE.w;
    const y = STAGE.h - 6 - rand() * 22;
    ctx.fillStyle = "rgba(48,62,48,0.9)";
    ctx.beginPath();
    ctx.ellipse(x, y, 55 + rand() * 60, 20 + rand() * 16, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  return canvas;
}
