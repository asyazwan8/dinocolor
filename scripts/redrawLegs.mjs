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
  { id: "legRearFar", hipX: 399, footX: 381, footY: 716, top: 58, sink: 36, ankle: 46, flare: 57 },
  { id: "legFrontFar", hipX: 738, footX: 725, footY: 724, top: 58, sink: 36, ankle: 46, flare: 57 },
  { id: "legRearNear", hipX: 571, footX: 557, footY: 746, top: 58, sink: 36, ankle: 47, flare: 58 },
  { id: "legFrontNear", hipX: 922, footX: 933, footY: 742, top: 58, sink: 36, ankle: 47, flare: 58 },
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
     * One limb: a haunch dome on top, sides falling away from it, a flared foot.
     *
     * The dome is a semicircle of radius `leg.top` centred EXACTLY on the hip pivot,
     * and it is the whole point of the shape. A circle rotated about its own centre
     * maps onto itself, so the contour where the limb meets the body slides along its
     * own curve instead of sweeping across the belly - which is what a straight-topped
     * limb does, and why the last sheet pulled open at the hip.
     *
     * The sides leave the dome VERTICALLY, tangent to it, so they slide along
     * themselves too and no corner opens where the arc ends. That is why the control
     * points below each tangent point sit straight below it; moving them sideways is
     * exactly what would put the notch back.
     *
     * This is the joint every 2D puppet rig draws. Spine's asset guidance asks for "an
     * area as close to a circle as possible where the joints overlap"; Live2D's is more
     * specific, and is what the radius follows - a semicircular joint end split on a
     * diameter through the pivot, radius equal to half the limb's width.
     */
    const limb = (leg) => {
      const { footX: fx, footY: fy, hipX: hx } = leg;
      /**
       * The pivot sits INSIDE the thigh, below the belly, not on it.
       *
       * Centred on the belly the circle shows a full semicircle above it and the limb
       * reads as a skittle - a bulb on a stick. Sinking it leaves only a swell of
       * haunch proud of the belly, which is what a thigh looks like, and it makes the
       * body's line meet that swell at a slant instead of square on. The arc is still
       * a circle about the pivot, so the joint is unchanged.
       */
      const hy = bellyAt(hx) + leg.sink;
      const R = leg.top;
      const ankleY = fy - (fy - hy) * 0.26;
      const drop = (ankleY - hy) * 0.45;

      ctx.beginPath();
      // the haunch, from the back tangent point up over the top to the front one
      ctx.arc(hx, hy, R, Math.PI, 0, false);
      // down the front, leaving the dome vertically
      ctx.bezierCurveTo(hx + R, hy + drop, fx + leg.ankle + 9, ankleY - drop * 0.6, fx + leg.ankle, ankleY);
      // the foot
      ctx.bezierCurveTo(fx + leg.ankle + 2, fy - 16, fx + leg.flare, fy - 14, fx + leg.flare, fy - 2);
      ctx.bezierCurveTo(fx + leg.flare * 0.4, fy + 6, fx - leg.flare * 0.4, fy + 6, fx - leg.flare, fy - 2);
      ctx.bezierCurveTo(fx - leg.flare, fy - 14, fx - leg.ankle - 2, fy - 16, fx - leg.ankle, ankleY);
      // back up the rear, arriving at the dome vertically
      ctx.bezierCurveTo(fx - leg.ankle - 9, ankleY - drop * 0.6, hx - R, hy + drop, hx - R, hy);
      ctx.closePath();
    };

    /**
     * The belly first, then the legs over the top of it.
     *
     * Each haunch rises above the belly and whites out the stretch it covers, so the
     * belly comes out as SEGMENTS running between the hips rather than one line drawn
     * across everything. That stops the animal reading as a rail with four table legs
     * under it - and it is the geometric requirement too, because a straight contour
     * passing through a pivot cannot rotate cleanly about it.
     */
    ctx.beginPath();
    through(BELLY);
    ctx.stroke();

    for (const leg of LEGS) {
      limb(leg);
      ctx.fillStyle = "#fff";
      ctx.fill();
      ctx.stroke();
    }

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
  const hipY = bellyAt(leg.hipX) + leg.sink;
  /**
   * The polygon covers the HAUNCH as well as the limb, dome and all.
   *
   * The dome is the joint: for the hip to hold still while the leg swings, the whole
   * disc about the pivot has to belong to the leg, so that rotating it turns the disc
   * onto itself. Claim only the part below the belly and the dome's ink is left
   * behind by the body, which is the tear this change exists to remove.
   *
   * The domes reach about 22px above the belly and sit 172 apart, so they stay well
   * clear of each other - the build assertion is the check.
   */
  const m = 4;
  const R = leg.top;
  const bottom = leg.footY + 16;
  const mid = (hipY + bottom) / 2;
  const wMid = (leg.top + leg.ankle) / 2 + m;
  const wFoot = leg.flare + m;
  const points = [
    [leg.hipX - R - m, hipY],
    [leg.hipX - R * 0.72, hipY - R - m],
    [leg.hipX + R * 0.72, hipY - R - m],
    [leg.hipX + R + m, hipY],
    [leg.footX + wMid, mid],
    [leg.footX + wFoot, bottom],
    [leg.footX - wFoot, bottom],
    [leg.footX - wMid, mid],
  ]
    .map(([x, y]) => `${cx(x)},${cy(y)}`)
    .join(" ");
  console.log(
    `    <polygon id="part-${leg.id}" data-parent="body" data-pivot="${cx(leg.hipX)},${cy(hipY)}" data-z="${z}"\n      points="${points}"/>\n`,
  );
}
