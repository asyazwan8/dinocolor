import { TEXTURE } from "@/lib/sheet/geometry";

/**
 * A stand-in for a child's scanned sheet, for demos and for looking at the screen
 * without printing anything. Scribbles overshoot their regions on purpose: staying
 * inside the lines would flatter the masks and hide exactly the case they exist for.
 */

const CRAYON = [
  "#e2483c", "#f0a32c", "#f6d63f", "#5fb35a", "#3f8fd0",
  "#8a56c0", "#e0699f", "#7a4a2a", "#42b8a8", "#d8603f",
];

function scribble(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, w: number, h: number,
  colour: string,
  rand: () => number,
): void {
  ctx.strokeStyle = colour;
  ctx.lineCap = "round";
  ctx.globalAlpha = 0.5;

  const strokes = Math.ceil((w * h) / 1400);
  for (let i = 0; i < strokes; i++) {
    const x = cx + (rand() - 0.5) * w;
    const y = cy + (rand() - 0.5) * h;
    const len = 26 + rand() * 60;
    const angle = -0.9 + rand() * 0.5;
    ctx.lineWidth = 9 + rand() * 12;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(angle) * len, y + Math.sin(angle) * len);
    ctx.stroke();
  }

  ctx.globalAlpha = 1;
}

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeDemoColouring(seed = Math.floor(Math.random() * 1e9)): HTMLCanvasElement {
  const rand = seeded(seed);
  const canvas = document.createElement("canvas");
  canvas.width = TEXTURE.w;
  canvas.height = TEXTURE.h;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");

  ctx.fillStyle = "#fdfcf7";
  ctx.fillRect(0, 0, TEXTURE.w, TEXTURE.h);

  const palette = [...CRAYON].sort(() => rand() - 0.5);

  // Body, then head end, then the leg band, then a couple of stray patches.
  scribble(ctx, 450, 380, 520, 300, palette[0], rand);
  scribble(ctx, 800, 300, 380, 330, palette[1], rand);
  scribble(ctx, 430, 560, 560, 260, palette[2], rand);
  scribble(ctx, 180, 400, 280, 150, palette[3], rand);
  scribble(ctx, 700, 560, 260, 200, palette[4], rand);

  return canvas;
}
