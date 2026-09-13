"use client";

import { useCallback, useRef, useState } from "react";
import { grabFrame, toCanvas } from "@/lib/vision/browser";
import { captureFromFrame, type CaptureResult } from "@/lib/vision/pipeline";

/**
 * Tuning harness.
 *
 * Iterating on corner detection by re-photographing a sheet with a phone every time
 * is the difference between a day of work and a week. Drop a photo here and see
 * exactly what the pipeline saw: where it put the border, what it rectified, and
 * which metric was responsible if it refused.
 */
export default function RectifyHarness() {
  const sourceRef = useRef<HTMLCanvasElement>(null);
  const outputRef = useRef<HTMLCanvasElement>(null);
  const [result, setResult] = useState<CaptureResult | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [filename, setFilename] = useState<string | null>(null);

  const run = useCallback(async (file: File) => {
    setFilename(file.name);
    const image = new Image();
    image.src = URL.createObjectURL(file);
    await image.decode();

    const frame = grabFrame(image);
    const started = performance.now();
    // The gate is skipped here on purpose: the whole point is to see what a photo
    // the gate would have rejected actually rectifies to.
    const capture = captureFromFrame(frame, { skipQualityGate: true, tryInvertedQr: true });
    setElapsed(performance.now() - started);
    setResult(capture);

    const source = sourceRef.current;
    if (source) {
      source.width = frame.width;
      source.height = frame.height;
      const ctx = source.getContext("2d");
      if (ctx) {
        ctx.drawImage(image, 0, 0);
        if (capture.boxCorners) {
          ctx.beginPath();
          capture.boxCorners.forEach((p, i) =>
            i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y),
          );
          ctx.closePath();
          ctx.lineWidth = Math.max(2, frame.width / 400);
          ctx.strokeStyle = capture.ok ? "#20c56a" : "#ff8a3d";
          ctx.stroke();

          capture.boxCorners.forEach((p, i) => {
            ctx.fillStyle = ["#ff3b30", "#ffcc00", "#34c759", "#0a84ff"][i];
            ctx.beginPath();
            ctx.arc(p.x, p.y, Math.max(4, frame.width / 220), 0, Math.PI * 2);
            ctx.fill();
          });
        }
      }
    }

    const output = outputRef.current;
    if (output && capture.ok) {
      output.width = capture.texture.width;
      output.height = capture.texture.height;
      output.getContext("2d")?.drawImage(toCanvas(capture.texture), 0, 0);
    } else if (output) {
      output.width = 1;
      output.height = 1;
    }

    URL.revokeObjectURL(image.src);
  }, []);

  return (
    <main style={{ maxWidth: 1100, margin: "0 auto", padding: 24, fontFamily: "ui-sans-serif, system-ui" }}>
      <h1 style={{ marginTop: 0 }}>Rectify harness</h1>
      <p style={{ color: "#5d6470", marginTop: 0 }}>
        Drop in a photo of a printed sheet. Corners are drawn in TL / TR / BR / BL order
        as red, yellow, green, blue.
      </p>

      <input
        type="file"
        accept="image/*"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void run(file);
        }}
      />

      {result ? (
        <section style={{ marginTop: 20 }}>
          <div style={panel}>
            <strong>{result.ok ? "Captured" : `Refused: ${result.failure.kind}`}</strong>
            <span>{filename}</span>
            <span>{elapsed.toFixed(0)} ms</span>
            {result.code ? (
              <span>
                {result.code.dino} &middot; {result.code.serial}
              </span>
            ) : null}
            {result.ok ? (
              <>
                <span>box confidence {(result.boxConfidence * 100).toFixed(0)}%</span>
                <span>QR disagreement {result.qrDisagreement.toFixed(2)}px</span>
                <span>
                  edges{" "}
                  {result.boxEdgeConfidence.map((c) => (c * 100).toFixed(0)).join(" / ")}
                </span>
              </>
            ) : (
              <span>{result.hint}</span>
            )}
          </div>

          {result.ok ? (
            <div style={panel}>
              <span>sharpness {result.metrics.sharpness.toFixed(0)}</span>
              <span>coverage {(result.metrics.coverage * 100).toFixed(1)}%</span>
              <span>exposure {result.metrics.exposure.toFixed(0)}</span>
              <span>range {result.metrics.dynamicRange.toFixed(0)}</span>
              <span>skew {result.metrics.skew.toFixed(3)}</span>
            </div>
          ) : null}
        </section>
      ) : null}

      <div style={{ display: "grid", gap: 18, gridTemplateColumns: "1fr", marginTop: 18 }}>
        <figure style={{ margin: 0 }}>
          <figcaption style={caption}>Source, with the detected border</figcaption>
          <canvas ref={sourceRef} style={canvasStyle} />
        </figure>
        <figure style={{ margin: 0 }}>
          <figcaption style={caption}>Rectified canonical texture</figcaption>
          <canvas ref={outputRef} style={{ ...canvasStyle, background: "#fff" }} />
        </figure>
      </div>
    </main>
  );
}

const panel: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 16,
  padding: "10px 14px",
  marginBottom: 8,
  background: "#fff",
  borderRadius: 10,
  fontSize: 14,
};
const caption: React.CSSProperties = { fontSize: 13, color: "#5d6470", marginBottom: 6 };
const canvasStyle: React.CSSProperties = {
  width: "100%",
  height: "auto",
  borderRadius: 10,
  border: "1px solid #dcdcd6",
};
