import { readFileSync } from "node:fs";
import { describe, it } from "vitest";
import type { RgbaImage } from "@/lib/vision/image";
import { captureFromFrame } from "@/lib/vision/pipeline";

/**
 * Replay a real photograph through the pipeline, with tracing.
 *
 *   node scripts/dumpPhoto.mjs shot.png /tmp/shot.raw
 *   DC_REPLAY=/tmp/shot.raw DC_TRACE=1 npx vitest run tests/replay.test.ts
 *
 * Skipped unless DC_REPLAY points at a dump, so it never runs in the normal suite.
 */
function load(path: string): RgbaImage {
  const buffer = readFileSync(path);
  const width = buffer.readUInt32LE(0);
  const height = buffer.readUInt32LE(4);
  return {
    data: new Uint8ClampedArray(buffer.buffer, buffer.byteOffset + 8, width * height * 4),
    width,
    height,
  };
}

describe("replay", () => {
  const path = process.env.DC_REPLAY;

  it.skipIf(!path)("runs the pipeline against a real photo", () => {
    const frame = load(path as string);
    const result = captureFromFrame(frame, { skipQualityGate: true });

    console.log(`frame ${frame.width}x${frame.height}`);
    if (result.ok) {
      console.log(
        `OK code=${result.code.dino}/${result.code.serial} ` +
          `qr=${result.qrDisagreement.toFixed(2)} ` +
          `edges=${result.boxEdgeConfidence.map((c) => (c * 100).toFixed(0)).join("/")}`,
      );
    } else {
      console.log(`REFUSED ${result.failure.kind}: ${result.hint}`);
    }
  });
});
