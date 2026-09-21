import { BufferAttribute, type BufferGeometry } from "three";

/**
 * Lay the child's drawing over an arbitrary model, by projecting it along the view axis.
 *
 * teamLab author each model's UV unwrap so that, laid flat, it reads as a picture - that
 * unwrap IS their colouring sheet. It is the highest-fidelity answer and it costs a
 * hand-authored unwrap and a redesigned sheet for every species.
 *
 * This is the cheap one, and it is cheap because of what the installation is: a valley
 * seen from the side, with animals walking left and right. Project the sheet straight
 * down the view axis and the near flank is exactly the drawing. The far flank gets a
 * mirror of it, and the top and underside streak - neither is ever pointed at anyone.
 *
 * Taken from the BIND POSE, so the drawing is glued to the surface and travels with the
 * animation instead of sliding over it. The geometry's own bounding box is already in
 * that space, which is why there is no transform here.
 */
export function projectDrawing(
  geometry: BufferGeometry,
  /** Where the drawing sits inside the canonical texture. */
  artwork: { x: number; y: number; w: number; h: number },
  texture: { w: number; h: number },
): void {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!box) throw new Error("that geometry has no positions to project");

  const spanX = box.max.x - box.min.x || 1;
  const spanY = box.max.y - box.min.y || 1;

  const position = geometry.getAttribute("position");
  const uv = new Float32Array(position.count * 2);

  for (let v = 0; v < position.count; v++) {
    const x = (position.getX(v) - box.min.x) / spanX;
    const y = (position.getY(v) - box.min.y) / spanY;

    // The sheet's y runs DOWN the page and the model's runs up, so the drawing is read
    // from the top of the box downwards.
    uv[v * 2] = (artwork.x + x * artwork.w) / texture.w;
    uv[v * 2 + 1] = (artwork.y + (1 - y) * artwork.h) / texture.h;
  }

  geometry.setAttribute("uv", new BufferAttribute(uv, 2));
}
