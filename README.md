# Dino Colourise

A venue installation in the spirit of teamLab's *Sketch Aquarium*, with dinosaurs.
A child colours a printed sheet, photographs it with their phone, and their **actual
drawing** — every crayon stroke — appears mapped onto a rigged 2.5D dinosaur walking
through a prehistoric valley on a 16:9 screen.

Currently a complete vertical slice: **Triceratops only**, end to end.

## Running it

```bash
npm install
npm run dev
```

| Route | What it is |
|---|---|
| `/` | Links to everything below |
| `/print/triceratops` | The printable sheet. `?count=20` prints twenty numbered ones |
| `/screen` | The big display. `?demo=6` populates it without a phone |
| `/scan` | The phone camera page, opened from the screen's QR |
| `/dev/rectify` | Tuning harness: drop in a photo, see what the pipeline saw |

Print **A4, landscape, 100% scale**. Do not use "fit to page" — scaling moves the box
away from where the scanner expects it.

## How it works

1. The sheet carries a thick black box and a QR inside it.
2. The phone decodes the QR to identify the sheet and get a rough fix on it.
3. It refines against the printed border, which spans the whole sheet and so pins the
   geometry far more tightly than the QR alone could.
4. The two are cross-checked against each other, the shot is gated on quality, and the
   sheet is flattened into a canonical 1200×800 texture and white-balanced.
5. That texture goes through a 60-second relay to the screen, which cuts it into rigged
   body parts and walks it into the valley.

The phone flow is three explicit steps — aim, shutter, send — not a loop that fires on
its own. The viewfinder calls `locateSheet`, which stops short of the warp: it exists
to draw an outline and say what to fix, and warping a megapixel per frame to throw it
away is most of the cost of a frame. The full capture runs once, on the shutter.

### The box is the fiducial

The dinosaur sits inside a box for design reasons. That box is also the best possible
perspective marker: four high-contrast corners spanning the whole sheet. The design
requirement and the hardest technical requirement turn out to be the same object.

### The drawing decides its own outline

The printed artwork is a PNG (`public/assets/dino/triceratops.png`).
`assets/dino/triceratops.svg` does not draw anything — it only says which bone owns
which region:

```xml
<polygon id="part-head" data-parent="frill" data-pivot="900,360" data-z="5" points="…"/>
```

A mask hand-traced around a raster outline is wrong in one direction or the other:
overshoot the ink and bare paper becomes part of the animal, undershoot and the
outline is clipped. So `scripts/buildRig.mjs` derives the silhouette from the artwork
itself, flooding inwards from the border — whatever the flood cannot reach is the
dinosaur. Each part's mask is that silhouette intersected with its polygon, so the
**outer** edge always follows the printed line exactly and the polygons only have to
be right about where one bone hands over to the next. Those boundaries are interior,
so being a few pixels out is invisible.

The build reports how much of the drawing no polygon claimed, and warns above 1% —
unclaimed ink is simply missing from the dinosaur on screen. `RIG_DEBUG=out.png`
renders the artwork with those gaps picked out in red.

Rig outputs are committed because the build needs Playwright and Chromium, which
Vercel's build step does not have.

The masks are what make messy colouring look deliberate: a child who scribbles far
outside the lines still gets a crisp silhouette.

## `lib/sheet/geometry.ts` is a contract

It is imported by **both** the print page and the vision pipeline. If those two ever
disagree about where the box or the QR sits, every capture is silently skewed —
skewed, not broken, which is worse. Constants are chosen so 1mm is exactly 5 canonical
pixels, making every documented coordinate an integer.

Change nothing there without re-running `npm test` and reprinting.

## Deployment

Deploys to Vercel as-is. One environment variable:

```
REDIS_URL=rediss://…      # Upstash. Optional in development.
```

Without it the relay falls back to an in-process bus, which is fine for `next dev` (one
process) and **not** viable in production, where every invocation is its own process.

Nothing is persisted. A photograph is never written to disk; the relay holds a 60-second
replay buffer purely so a screen that reconnects is repopulated rather than sitting
empty, and then it expires.

## Testing

```bash
npm test                                  # unit + synthetic capture harness
node scripts/e2eCapture.mjs               # photographs the real print route at 3 angles
node scripts/e2eLoop.mjs                  # print → colour → photo → relay → screen
node scripts/previewRig.mjs triceratops out.png   # rig composited over a test texture

# Drive the real /scan page, fake camera and all
node scripts/makeFakeCam.mjs photo.png /tmp/cam.y4m
node scripts/e2eScan.mjs /tmp/cam.y4m
```

The end-to-end scripts need `npm run dev` running. They caught several defects the unit
tests could not, because the unit tests build their own synthetic sheet and so cannot
tell you whether the printed page matches the contract.

To debug a real photograph:

```bash
node scripts/dumpPhoto.mjs shot.png /tmp/shot.raw
DC_REPLAY=/tmp/shot.raw npx vitest run tests/replay.test.ts
```

Measured on the printed sheet: flat, tilted and steeply angled photographs all recover
the sheet within about 2px (~0.4mm). Past roughly a fifth of foreshortening it declines
rather than returning a confident answer that would put the printed frame through the
middle of the drawing.

## Artwork

Both the dinosaur and the valley are supplied art:

```
public/assets/dino/triceratops.png   the printed colouring page
public/assets/world/valley.webp      the painted backdrop
```

Originals are kept in `assets/source/`. To swap either, replace the file and re-run
`node scripts/buildRig.mjs triceratops` — the rig JSON records where the artwork sits
inside the box, and the print page reads that same record, so the sheet and the
scanner cannot drift apart.

If the backdrop is missing the renderer falls back to the procedural scenery in
`world/procedural.ts`, which is built to be good enough to run an installation on.
The bottom strip of the backdrop is drawn again in front of the dinosaurs, so the
nearest ones stand *in* the meadow rather than on top of it — same pixels, so it
costs no extra art and cannot mismatch.

## Not done yet

Stegosaurus, T-rex and Brachiosaurus (art, rigs and the size story that needs all four);
Magnific shading maps to replace the procedural form shadow; multi-session support;
screen interaction; dinosaurs reacting to each other.
