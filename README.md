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

### The box is the fiducial

The dinosaur sits inside a box for design reasons. That box is also the best possible
perspective marker: four high-contrast corners spanning the whole sheet. The design
requirement and the hardest technical requirement turn out to be the same object.

### The SVG is the rig

`assets/dino/triceratops.svg` is both the printed line art and the rig definition. Each
body part is a named path carrying its pivot, parent bone and draw order:

```xml
<path id="part-head" data-parent="frill" data-pivot="800,340" data-z="5" d="..."/>
```

`node scripts/buildRig.mjs triceratops` turns that one file into the rig JSON, the
per-part alpha masks and the per-part line art. Rig outputs are committed because the
build needs Playwright and Chromium, which Vercel's build step does not have.

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

The dinosaur line art is hand-authored SVG, because a rig needs exact part geometry and
generated art does not have it.

World layers are Magnific art, generated then **downloaded and committed by hand** — the
session that builds this cannot reach the image CDN. Drop them in as:

```
public/assets/world/{sky,mountains,hills,treeline,ground,foreground}.png
```

Anything absent falls back to the procedural scenery in `world/procedural.ts`, which is
built to be good enough to run an installation on.

## Not done yet

Stegosaurus, T-rex and Brachiosaurus (art, rigs and the size story that needs all four);
Magnific shading maps to replace the procedural form shadow; multi-session support;
screen interaction; dinosaurs reacting to each other.
