import { describe, expect, it } from "vitest";
import {
  BOX_BORDER_MM,
  BOX_INNER_CANVAS_CORNERS,
  BOX_INNER_MM,
  BOX_OUTER_CANVAS_CORNERS,
  BOX_OUTER_MM,
  PAGE_MM,
  PX_PER_MM,
  QR_CANVAS_CORNERS,
  QR_MM,
  TEXTURE,
  canvasToMm,
  mmToCanvas,
} from "@/lib/sheet/geometry";

describe("sheet geometry contract", () => {
  it("puts the box inner top-left at the canonical origin", () => {
    expect(mmToCanvas(BOX_INNER_MM.x, BOX_INNER_MM.y)).toEqual({ x: 0, y: 0 });
  });

  it("maps the box inner rect onto exactly the texture size", () => {
    expect(BOX_INNER_CANVAS_CORNERS).toEqual([
      { x: 0, y: 0 },
      { x: TEXTURE.w, y: 0 },
      { x: TEXTURE.w, y: TEXTURE.h },
      { x: 0, y: TEXTURE.h },
    ]);
  });

  it("places the QR at the documented canonical pixels", () => {
    expect(QR_CANVAS_CORNERS[0]).toEqual({ x: 1040, y: 640 });
    expect(QR_CANVAS_CORNERS[2]).toEqual({ x: 1160, y: 760 });
  });

  it("puts the border outside the texture by exactly the border width", () => {
    const inset = BOX_BORDER_MM * PX_PER_MM;
    expect(BOX_OUTER_CANVAS_CORNERS[0]).toEqual({ x: -inset, y: -inset });
    expect(BOX_OUTER_CANVAS_CORNERS[2]).toEqual({
      x: TEXTURE.w + inset,
      y: TEXTURE.h + inset,
    });
  });

  it("keeps outer = inner + 2x border on both axes", () => {
    expect(BOX_OUTER_MM.w).toBe(BOX_INNER_MM.w + 2 * BOX_BORDER_MM);
    expect(BOX_OUTER_MM.h).toBe(BOX_INNER_MM.h + 2 * BOX_BORDER_MM);
    expect(BOX_OUTER_MM.x).toBe(BOX_INNER_MM.x - BOX_BORDER_MM);
    expect(BOX_OUTER_MM.y).toBe(BOX_INNER_MM.y - BOX_BORDER_MM);
  });

  it("keeps the texture aspect identical to the printed box aspect", () => {
    expect(TEXTURE.w / TEXTURE.h).toBeCloseTo(BOX_INNER_MM.w / BOX_INNER_MM.h, 10);
  });

  it("keeps the whole box on the page", () => {
    expect(BOX_OUTER_MM.x).toBeGreaterThan(0);
    expect(BOX_OUTER_MM.y).toBeGreaterThan(0);
    expect(BOX_OUTER_MM.x + BOX_OUTER_MM.w).toBeLessThanOrEqual(PAGE_MM.w);
    expect(BOX_OUTER_MM.y + BOX_OUTER_MM.h).toBeLessThanOrEqual(PAGE_MM.h);
  });

  it("keeps the QR and its quiet zone inside the box", () => {
    expect(QR_MM.x - QR_MM.quiet).toBeGreaterThanOrEqual(BOX_INNER_MM.x);
    expect(QR_MM.y - QR_MM.quiet).toBeGreaterThanOrEqual(BOX_INNER_MM.y);
    expect(QR_MM.x + QR_MM.size + QR_MM.quiet).toBeLessThanOrEqual(
      BOX_INNER_MM.x + BOX_INNER_MM.w,
    );
    expect(QR_MM.y + QR_MM.size + QR_MM.quiet).toBeLessThanOrEqual(
      BOX_INNER_MM.y + BOX_INNER_MM.h,
    );
  });

  it("round-trips mm to canvas and back", () => {
    for (const [x, y] of [[28.5, 30], [100, 77.5], [268.5, 190]]) {
      const back = canvasToMm(mmToCanvas(x, y).x, mmToCanvas(x, y).y);
      expect(back.x).toBeCloseTo(x, 10);
      expect(back.y).toBeCloseTo(y, 10);
    }
  });
});
