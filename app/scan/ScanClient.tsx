"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { sanitizeSession } from "@/lib/relay/types";
import { DINOS } from "@/lib/sheet/types";
import { encodeWebp, grabFrame, openRearCamera, stopStream, toCanvas } from "@/lib/vision/browser";
import { captureFromFrame } from "@/lib/vision/pipeline";

/**
 * Live guidance runs at this width, not the sensor's. QR decoding dominates the
 * frame cost and scales with pixel count, so a full-resolution preview loop would
 * drop to a couple of frames a second and make the sheet genuinely hard to aim at.
 * The frame that actually gets sent is taken at full resolution.
 */
const GUIDANCE_WIDTH = 900;
const GUIDANCE_INTERVAL_MS = 220;

type Phase = "idle" | "starting" | "hunting" | "sending" | "sent" | "error";

export default function ScanClient() {
  const params = useSearchParams();
  const session = sanitizeSession(params.get("s"));

  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const busyRef = useRef(false);

  const [phase, setPhase] = useState<Phase>("idle");
  const [hint, setHint] = useState("Point the camera at the whole sheet");
  const [error, setError] = useState<string | null>(null);
  const [sentDino, setSentDino] = useState<string | null>(null);

  const drawOutline = useCallback((corners: { x: number; y: number }[] | undefined, ok: boolean) => {
    const canvas = overlayRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;

    const width = video.clientWidth;
    const height = video.clientHeight;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    if (!corners?.length || !video.videoWidth) return;

    // The preview is object-fit: cover, so the same crop has to be applied here or
    // the outline drifts away from the sheet the moment the aspect ratios differ.
    const scale = Math.max(width / video.videoWidth, height / video.videoHeight);
    const offsetX = (width - video.videoWidth * scale) / 2;
    const offsetY = (height - video.videoHeight * scale) / 2;

    ctx.beginPath();
    corners.forEach((p, i) => {
      const x = p.x * scale + offsetX;
      const y = p.y * scale + offsetY;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.lineWidth = 4;
    ctx.strokeStyle = ok ? "#3ddc84" : "#ffd166";
    ctx.stroke();
  }, []);

  const send = useCallback(
    async (dataUrl: string, dino: string, serial: string) => {
      setPhase("sending");
      const response = await fetch("/api/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session, dino, serial, texture: dataUrl }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "could not send");
      }
      setSentDino(DINOS[dino as keyof typeof DINOS]?.name ?? dino);
      setPhase("sent");
    },
    [session],
  );

  useEffect(() => {
    if (phase !== "hunting") return;

    const timer = setInterval(() => {
      const video = videoRef.current;
      if (!video || busyRef.current || video.readyState < 2) return;
      busyRef.current = true;

      try {
        const preview = captureFromFrame(grabFrame(video, GUIDANCE_WIDTH));
        const scaleBack = video.videoWidth / Math.min(GUIDANCE_WIDTH, video.videoWidth);
        drawOutline(
          preview.boxCorners?.map((p) => ({ x: p.x * scaleBack, y: p.y * scaleBack })),
          preview.ok,
        );

        if (!preview.ok) {
          setHint(preview.hint);
          return;
        }

        // Guidance says the shot is good; redo it at full resolution, because that
        // is the frame whose pixels a child actually sees on the screen.
        const full = captureFromFrame(grabFrame(video));
        if (!full.ok) {
          setHint(full.hint);
          return;
        }

        void send(encodeWebp(toCanvas(full.texture)), full.code.dino, full.code.serial).catch(
          (e: unknown) => {
            setError(e instanceof Error ? e.message : "could not send");
            setPhase("error");
          },
        );
      } catch {
        // A dropped frame is not worth surfacing; the next tick will try again.
      } finally {
        busyRef.current = false;
      }
    }, GUIDANCE_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [phase, drawOutline, send]);

  useEffect(() => () => stopStream(streamRef.current), []);

  const start = async () => {
    setPhase("starting");
    setError(null);
    try {
      const video = videoRef.current;
      if (!video) throw new Error("no video element");
      streamRef.current = await openRearCamera(video);
      setPhase("hunting");
    } catch {
      setError("Camera permission is needed to scan your sheet.");
      setPhase("error");
    }
  };

  const again = () => {
    setSentDino(null);
    setHint("Point the camera at the whole sheet");
    setPhase("hunting");
  };

  return (
    <main style={shell}>
      <div style={stage}>
        <video ref={videoRef} playsInline muted style={videoStyle} />
        <canvas ref={overlayRef} style={overlayStyle} />

        {phase === "idle" || phase === "starting" ? (
          <div style={curtain}>
            <h1 style={{ fontSize: 26, margin: 0 }}>Dino Colourise</h1>
            <p style={{ opacity: 0.8, maxWidth: 300, textAlign: "center" }}>
              Hold your coloured sheet flat and fill the frame with it.
            </p>
            <button onClick={start} style={button} disabled={phase === "starting"}>
              {phase === "starting" ? "Starting…" : "Start camera"}
            </button>
          </div>
        ) : null}

        {phase === "sent" ? (
          <div style={curtain}>
            <div style={{ fontSize: 46 }}>🦕</div>
            <h2 style={{ margin: 0 }}>Your {sentDino} is in the valley</h2>
            <p style={{ opacity: 0.78 }}>Look up at the big screen.</p>
            <button onClick={again} style={button}>
              Scan another
            </button>
          </div>
        ) : null}

        {phase === "error" ? (
          <div style={curtain}>
            <h2 style={{ margin: 0 }}>Something went wrong</h2>
            <p style={{ opacity: 0.8, textAlign: "center", maxWidth: 300 }}>{error}</p>
            <button onClick={start} style={button}>
              Try again
            </button>
          </div>
        ) : null}
      </div>

      {phase === "hunting" || phase === "sending" ? (
        <footer style={hintBar}>{phase === "sending" ? "Sending…" : hint}</footer>
      ) : null}
    </main>
  );
}

const shell: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "#0b0f0d",
  color: "#fff",
  display: "flex",
  flexDirection: "column",
};
const stage: React.CSSProperties = { position: "relative", flex: 1, overflow: "hidden" };
const videoStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  objectFit: "cover",
};
const overlayStyle: React.CSSProperties = { position: "absolute", inset: 0, pointerEvents: "none" };
const curtain: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 16,
  background: "rgba(8, 14, 11, 0.88)",
  padding: 24,
  font: "500 15px/1.5 ui-sans-serif, system-ui, sans-serif",
};
const button: React.CSSProperties = {
  appearance: "none",
  border: 0,
  borderRadius: 999,
  padding: "14px 28px",
  fontSize: 16,
  fontWeight: 700,
  background: "#3ddc84",
  color: "#07120c",
};
const hintBar: React.CSSProperties = {
  padding: "16px 20px calc(16px + env(safe-area-inset-bottom))",
  textAlign: "center",
  font: "600 16px/1.3 ui-sans-serif, system-ui, sans-serif",
  background: "#101915",
};
