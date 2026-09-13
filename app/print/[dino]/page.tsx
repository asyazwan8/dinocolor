import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { notFound } from "next/navigation";
import QRCode from "qrcode";
import { formatSheetCode } from "@/lib/sheet/code";
import {
  BOX_BORDER_MM,
  BOX_INNER_MM,
  BOX_OUTER_MM,
  FOOTER_MM,
  PAGE_MM,
  QR_MM,
  TITLE_BAND_MM,
} from "@/lib/sheet/geometry";
import { dinoBySlug, type DinoSpec } from "@/lib/sheet/types";

const MAX_SHEETS = 60;

/**
 * High error correction. These sheets get folded, smudged with crayon and
 * photographed at an angle by a child, so recoverability matters more than keeping
 * the symbol sparse. The payload is only 12 characters, so even at level H the
 * module size at 24mm stays comfortably above what a phone camera resolves.
 */
async function qrSvg(payload: string): Promise<string> {
  return QRCode.toString(payload, {
    type: "svg",
    margin: 0,
    errorCorrectionLevel: "H",
    color: { dark: "#111111", light: "#ffffff" },
  });
}

function serialFor(index: number, start: number): string {
  return String(start + index).padStart(4, "0");
}

function Sheet({ dino, serial, art, qr }: {
  dino: DinoSpec;
  serial: string;
  art: string;
  qr: string;
}) {
  return (
    <div className="sheet">
      <div className="title">
        <span className="wordmark">Dino Colourise</span>
        <span className="species">{dino.name}</span>
      </div>

      <div className="box">
        {/* Art fills the box interior exactly, so canonical pixels map 1:1 to the
            rectified texture the scanner produces. */}
        <div className="art" dangerouslySetInnerHTML={{ __html: art }} />

        {/* The quiet zone is painted white so crayon straying near the code cannot
            break decoding. */}
        <div className="quiet">
          <div className="qr" dangerouslySetInnerHTML={{ __html: qr }} />
        </div>
      </div>

      <div className="footer">
        <span>Colour me in, then scan me with the camera to bring me to life.</span>
        <span className="serial">
          {dino.code} &middot; {serial}
        </span>
      </div>
    </div>
  );
}

export default async function PrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ dino: string }>;
  searchParams: Promise<{ count?: string; from?: string }>;
}) {
  const { dino: slug } = await params;
  const dino = dinoBySlug(slug);
  if (!dino) notFound();

  const query = await searchParams;
  const count = Math.min(MAX_SHEETS, Math.max(1, Number(query.count ?? 1) || 1));
  const start = Math.max(1, Number(query.from ?? 1) || 1);

  const art = await readFile(resolve(`assets/dino/${dino.slug}.svg`), "utf8");

  const sheets = await Promise.all(
    Array.from({ length: count }, async (_, i) => {
      const serial = serialFor(i, start);
      return {
        serial,
        qr: await qrSvg(formatSheetCode(dino.code, serial)),
      };
    }),
  );

  return (
    <>
      <style>{css}</style>
      <div className="screen-only">
        Printing {count} sheet{count === 1 ? "" : "s"} &mdash; A4, landscape, 100% scale.
        Turn off &ldquo;fit to page&rdquo;.
      </div>
      {sheets.map((sheet) => (
        <Sheet key={sheet.serial} dino={dino} serial={sheet.serial} art={art} qr={sheet.qr} />
      ))}
    </>
  );
}

/**
 * Every measurement comes from lib/sheet/geometry.ts. Nothing here may be nudged by
 * eye: the scanner assumes the box and QR are exactly where these constants say.
 */
const css = `
@page { size: A4 landscape; margin: 0; }

body { background: #6b7280; }

.screen-only {
  font: 500 14px/1.5 ui-sans-serif, system-ui, sans-serif;
  color: #fff; padding: 16px 20px; text-align: center;
}

.sheet {
  position: relative;
  width: ${PAGE_MM.w}mm;
  height: ${PAGE_MM.h}mm;
  background: #fff;
  margin: 0 auto 12px;
  overflow: hidden;
  break-after: page;
}

.title {
  position: absolute;
  left: 0; top: 0;
  width: ${TITLE_BAND_MM.w}mm; height: ${TITLE_BAND_MM.h}mm;
  display: flex; align-items: center; justify-content: center; gap: 6mm;
}
.wordmark {
  font: 800 13mm/1 ui-sans-serif, system-ui, sans-serif;
  letter-spacing: 0.4mm; color: #111;
}
.species {
  font: 600 5mm/1 ui-sans-serif, system-ui, sans-serif;
  color: #555; align-self: flex-end; padding-bottom: 2.4mm;
}

/* border-box sizing makes the outer rect ${BOX_OUTER_MM.w}x${BOX_OUTER_MM.h}mm and the
   interior exactly ${BOX_INNER_MM.w}x${BOX_INNER_MM.h}mm - the fiducial the scanner finds. */
.box {
  position: absolute;
  left: ${BOX_OUTER_MM.x}mm; top: ${BOX_OUTER_MM.y}mm;
  width: ${BOX_OUTER_MM.w}mm; height: ${BOX_OUTER_MM.h}mm;
  border: ${BOX_BORDER_MM}mm solid #111;
  background: #fff;
}

.art { position: absolute; left: 0; top: 0;
  width: ${BOX_INNER_MM.w}mm; height: ${BOX_INNER_MM.h}mm; }
.art svg { display: block; width: 100%; height: 100%; }

.quiet {
  position: absolute;
  left: ${QR_MM.x - QR_MM.quiet - BOX_INNER_MM.x}mm;
  top: ${QR_MM.y - QR_MM.quiet - BOX_INNER_MM.y}mm;
  width: ${QR_MM.size + QR_MM.quiet * 2}mm;
  height: ${QR_MM.size + QR_MM.quiet * 2}mm;
  background: #fff;
  display: flex; align-items: center; justify-content: center;
}
.qr { width: ${QR_MM.size}mm; height: ${QR_MM.size}mm; }
.qr svg { display: block; width: 100%; height: 100%; shape-rendering: crispEdges; }

.footer {
  position: absolute;
  left: 0; top: ${FOOTER_MM.y}mm;
  width: ${FOOTER_MM.w}mm; height: ${FOOTER_MM.h}mm;
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 ${BOX_OUTER_MM.x}mm;
  font: 500 3.6mm/1 ui-sans-serif, system-ui, sans-serif;
  color: #666;
}
.serial { font-variant-numeric: tabular-nums; color: #999; }

@media print {
  body { background: #fff; }
  .screen-only { display: none; }
  .sheet { margin: 0; box-shadow: none; }
}
`;
