/**
 * Redraw the printed sheet with the four legs clearly separated.
 *
 *   node scripts/redrawLegs.mjs [out.png]
 *
 * Why the sheet needs this at all: a near limb and a far limb that touch on the paper
 * are one connected piece of mesh, and they swing in opposite directions, so the
 * triangles bridging them are asked to be in two places at once. Everything
 * downstream - warped legs, folded triangles, black shards between the feet - follows
 * from that one fact, and no choice of weights avoids it. Limbs that never touch
 * cannot produce it. This is how teamLab's sheets work: the template is authored for
 * the rig rather than retrofitted to it.
 *
 * Only the legs change. Body, head, frill and tail are left exactly as drawn, and the
 * erase is bounded to the belly line so nothing above it is touched.
 *
 * (Posing the existing legs apart with the rig was tried first, and cannot work: where
 * two legs overlap, the ink belongs to both at once, so pulling them apart tears it.
 * The overlap has to stop existing in the drawing, not in the mesh.)
 *
 * Everything below is in ARTWORK pixels, the source PNG's own 1216x896 frame, so the
 * output drops straight back in where the old one was.
 */
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const CHROMIUM =
  process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

const SOURCE = "assets/source/triceratops-lineart.png";
/**
 * Reads the original sheet and writes the printed one, so re-running never redraws
 * over its own output. assets/source holds the drawing as it arrived; public holds
 * the version the rig and the print route actually use.
 */
const out = process.argv[2] ?? "public/assets/dino/triceratops.png";

/** Matches the printed drawing: solid black, even weight, rounded ends. */
const STROKE = 9;

/**
 * The underside of the body, measured rather than guessed.
 *
 * Most of the belly is hidden behind the legs, but it shows through in three places -
 * beside the tail, between the middle pair, and in front of the chest - and the
 * silhouette's lowest row in those columns is the belly itself. These points are
 * those measurements (y 536-546 at x 330-362, y 609 at x 640, y 533-538 at x 935-980)
 * with a smooth curve continued across the stretches the legs cover.
 */
const BELLY = [
  [338, 546],
  [370, 541],
  [440, 578],
  [520, 598],
  [610, 607],
  [685, 609],
  [762, 601],
  [840, 580],
  [902, 551],
  [945, 534],
  [988, 543],
];

/** Everything below the belly, between these columns, is erased and redrawn. */
const ERASE_FROM = 340;
const ERASE_TO = 996;

/**
 * The four legs.
 *
 * All of them stop at the belly and are capped by it, which is how the original sheet
 * draws them: on a flat cartoon like this, depth comes from where a limb sits and how
 * big it is, not from overlapping the body. Letting the near pair ride up into the
 * torso was tried and reads worse - the outlines end in mid-body with nothing to meet.
 *
 * Which leg is in front is the skeleton's business, not the drawing's: data-z orders
 * them, and buildRig sorts the triangles by it so a crossing limb paints correctly.
 *
 * The x positions are set so no two limbs come within 45 artwork pixels (40 canonical)
 * of each other anywhere below the belly - the distance below which a single mesh
 * triangle could reach into both. See the assertion in buildRig.mjs.
 */
const LEGS = [
  { id: "legRearFar", hipX: 399, footX: 378, footY: 726, top: 56, ankle: 33, flare: 55 },
  { id: "legFrontFar", hipX: 744, footX: 733, footY: 734, top: 56, ankle: 34, flare: 56 },
  { id: "legRearNear", hipX: 571, footX: 558, footY: 756, top: 56, ankle: 34, flare: 56 },
  { id: "legFrontNear", hipX: 916, footX: 928, footY: 752, top: 56, ankle: 34, flare: 56 },
];

const sourceDataUrl = `data:image/png;base64,${readFileSync(resolve(SOURCE)).toString(
  "base64",
)}`;

const browser = await chromium.launch({ executablePath: CHROMIUM });
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });

const png = await page.evaluate(
  async ({ sourceDataUrl, BELLY, LEGS, STROKE, ERASE_FROM, ERASE_TO }) => {
    const art = new Image();
    art.src = sourceDataUrl;
    await art.decode();

    const canvas = document.createElement("canvas");
    canvas.width = art.naturalWidth;
    canvas.height = art.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(art, 0, 0);

    /** A smooth curve through the given points, as a path. */
    const through = (points) => {
      ctx.moveTo(points[0][0], points[0][1]);
      for (let i = 0; i < points.length - 1; i++) {
        const [x0, y0] = points[i];
        const [x1, y1] = points[i + 1];
        const [xp, yp] = points[i - 1] ?? points[i];
        const [xn, yn] = points[i + 2] ?? points[i + 1];
        ctx.bezierCurveTo(
          x0 + (x1 - xp) / 6,
          y0 + (y1 - yp) / 6,
          x1 - (xn - x0) / 6,
          y1 - (yn - y0) / 6,
          x1,
          y1,
        );
      }
    };

    /** The belly's height at a given column, by interpolating the traced points. */
    const bellyAt = (x) => {
      for (let i = 0; i < BELLY.length - 1; i++) {
        const [x0, y0] = BELLY[i];
        const [x1, y1] = BELLY[i + 1];
        if (x >= x0 && x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
      }
      return x < BELLY[0][0] ? BELLY[0][1] : BELLY[BELLY.length - 1][1];
    };

    /**
     * Erase below the belly, keeping the belly itself.
     *
     * The traced points are the lowest row of the silhouette, which is the OUTER edge
     * of the printed line - so cutting one pixel under them takes the legs away and
     * leaves the drawn belly whole. It never has to be redrawn, which is the only way
     * to be sure it still matches the body it belongs to.
     */
    ctx.save();
    ctx.beginPath();
    ctx.rect(ERASE_FROM, 0, ERASE_TO - ERASE_FROM, canvas.height);
    ctx.clip();
    ctx.beginPath();
    through(BELLY.map(([x, y]) => [x, y + 1]));
    ctx.lineTo(ERASE_TO + 40, canvas.height);
    ctx.lineTo(ERASE_FROM - 40, canvas.height);
    ctx.closePath();
    ctx.fillStyle = "#fff";
    ctx.fill();
    ctx.restore();

    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#1a1a1a";
    ctx.lineWidth = STROKE;

    /**
     * One limb, as an OPEN path: down the back, round the sole, up the front.
     *
     * Open on purpose. A closed path would stroke a line straight across the top of
     * the limb, and there is no such line on a dinosaur - the thigh simply continues
     * into the body. Filling uses the same path closed, which is what lets a near leg
     * white out the belly behind it.
     */
    const limb = (leg, backY, frontY) => {
      const { footX: fx, footY: fy, hipX: hx } = leg;
      const ankleOf = (hipY) => fy - (fy - hipY) * 0.26;
      const ab = ankleOf(backY);
      const af = ankleOf(frontY);
      ctx.beginPath();
      ctx.moveTo(hx - leg.top, backY);
      ctx.bezierCurveTo(
        hx - leg.top - 3,
        backY + (ab - backY) * 0.45,
        fx - leg.ankle - 9,
        ab - (ab - backY) * 0.3,
        fx - leg.ankle,
        ab,
      );
      ctx.bezierCurveTo(fx - leg.ankle - 2, fy - 16, fx - leg.flare, fy - 14, fx - leg.flare, fy - 2);
      ctx.bezierCurveTo(fx - leg.flare * 0.4, fy + 6, fx + leg.flare * 0.4, fy + 6, fx + leg.flare, fy - 2);
      ctx.bezierCurveTo(fx + leg.flare, fy - 14, fx + leg.ankle + 2, fy - 16, fx + leg.ankle, af);
      ctx.bezierCurveTo(
        fx + leg.ankle + 9,
        af - (af - frontY) * 0.3,
        hx + leg.top + 3,
        frontY + (af - frontY) * 0.45,
        hx + leg.top,
        frontY,
      );
    };

    const draw = (leg) => {
      /**
       * Each side of the limb ends at the belly's height for ITS OWN column, not the
       * hip's. The belly slopes, and a limb 120px wide crosses enough of that slope
       * that a single height leaves one corner poking through the body's outline.
       */
      const back = bellyAt(leg.hipX - leg.top) + 4;
      const front = bellyAt(leg.hipX + leg.top) + 4;
      limb(leg, back, front);
      ctx.fillStyle = "#fff";
      ctx.fill();
      limb(leg, back, front);
      ctx.stroke();
    };

    /**
     * Legs first, then the belly over the top of them.
     *
     * That order is what caps each limb: the belly line lands across the open top of
     * every leg, so the thigh runs into the body with no line drawn across it - there
     * is no such line on a dinosaur.
     *
     * Most of the belly has to be drawn rather than kept: on the original sheet the
     * legs covered it, so between them there is simply no line to preserve.
     */
    for (const leg of LEGS) draw(leg);

    ctx.beginPath();
    through(BELLY);
    ctx.stroke();

    return canvas.toDataURL("image/png");
  },
  { sourceDataUrl, BELLY, LEGS, STROKE, ERASE_FROM, ERASE_TO },
);

await browser.close();

writeFileSync(resolve(out), Buffer.from(png.split(",")[1], "base64"));
console.log(`triceratops: legs redrawn -> ${out}`);

/**
 * The skeleton has to agree with the drawing, and this script is the only thing that
 * knows where the new limbs are - so it emits the polygons and pivots rather than
 * leaving them to be re-measured off the image by eye.
 *
 * The rig works in canonical texture pixels, which is the 1216x896 sheet fitted into
 * a 1200x800 frame: scaled to height and centred, exactly as buildRig places it.
 */
const SCALE = Math.min(1200 / 1216, 800 / 896);
const OFFSET_X = (1200 - 1216 * SCALE) / 2;
const cx = (x) => Math.round(OFFSET_X + x * SCALE);
const cy = (y) => Math.round(y * SCALE);

const bellyAt = (x) => {
  for (let i = 0; i < BELLY.length - 1; i++) {
    const [x0, y0] = BELLY[i];
    const [x1, y1] = BELLY[i + 1];
    if (x >= x0 && x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return x < BELLY[0][0] ? BELLY[0][1] : BELLY[BELLY.length - 1][1];
};

console.log("\nfor assets/dino/triceratops.svg:\n");
let z = 3;
for (const leg of LEGS) {
  z++;
  const hipY = bellyAt(leg.hipX);
  /**
   * The polygon starts just BELOW the belly, never above it.
   *
   * Above the belly is body, and up there the four thighs converge - claiming that
   * strip for the limbs puts two different limbs within one triangle of each other
   * however far apart the feet are, which is exactly what the build assertion
   * refuses. The thigh still moves with the leg: relaxation carries the limb's
   * weight up across the hip, which is what makes the hip bend rather than hinge.
   */
  const top = hipY + 6;
  const bottom = leg.footY + 16;
  const mid = (top + bottom) / 2;
  const wTop = leg.top + 2;
  const wMid = (leg.top + leg.ankle) / 2 + 2;
  const wFoot = leg.flare + 2;
  const points = [
    [leg.hipX - wTop, top],
    [leg.hipX + wTop, top],
    [leg.footX + wMid, mid],
    [leg.footX + wFoot, bottom],
    [leg.footX - wFoot, bottom],
    [leg.footX - wMid, mid],
  ]
    .map(([x, y]) => `${cx(x)},${cy(y)}`)
    .join(" ");
  console.log(
    `    <polygon id="part-${leg.id}" data-parent="body" data-pivot="${cx(leg.hipX)},${cy(hipY - 8)}" data-z="${z}"\n      points="${points}"/>\n`,
  );
}
