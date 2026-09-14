"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { sanitizeSession } from "@/lib/relay/types";
import { DINOS } from "@/lib/sheet/types";
import { encodeTexture, grabFrame, openRearCamera, stopStream, toCanvas } from "@/lib/vision/browser";
import { captureFromFrame, locateSheet } from "@/lib/vision/pipeline";

/**
 * The viewfinder runs at this width, not the sensor's. QR decoding dominates the
 * cost of a frame and scales with pixel count, so a full-resolution preview loop
 * drops to a couple of frames a second and makes the sheet hard to aim at. The frame
 * that is actually kept is taken at full resolution.
 */
const AIM_WIDTH = 760;
const AIM_INTERVAL_MS = 200;

type Phase = "idle" | "starting" | "aiming" | "captured" | "sending" | "sent" | "error";

export default function ScanClient() {
  const params = useSearchParams();
  const session = sanitizeSession(params.get("s"));

  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const busyRef = useRef(false);
  const shotRef = useRef<{ texture: string; dino: string; serial: string } | null>(null);

  const [phase, setPhase] = useState<Phase>("idle");
  const [hint, setHint] = useState("Point the camera at the whole sheet");
  const [ready, setReady] = useState(false);
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
    ctx.lineWidth = 5;
    ctx.strokeStyle = ok ? "#3ddc84" : "#ffd166";
    ctx.stroke();
  }, []);

  // Viewfinder: locate only, never warp. It exists to draw the outline and say what
  // to fix, and doing the full capture here would cost a warp per frame for pixels
  // nobody keeps.
  useEffect(() => {
    if (phase !== "aiming") return;

    const timer = setInterval(() => {
      const video = videoRef.current;
      if (!video || busyRef.current || video.readyState < 2) return;
      busyRef.current = true;

      try {
        const found = locateSheet(grabFrame(video, AIM_WIDTH));
        const back = video.videoWidth / Math.min(AIM_WIDTH, video.videoWidth);
        drawOutline(
          found.boxCorners?.map((p) => ({ x: p.x * back, y: p.y * back })),
          found.ok,
        );
        setReady(found.ok);
        setHint(found.ok ? "Looks good — take the photo" : found.hint);
      } catch {
        // A dropped frame is not worth surfacing; the next tick tries again.
      } finally {
        busyRef.current = false;
      }
    }, AIM_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [phase, drawOutline]);

  useEffect(() => () => stopStream(streamRef.current), []);

  const start = async () => {
    setPhase("starting");
    setError(null);
    try {
      const video = videoRef.current;
      if (!video) throw new Error("no video element");
      streamRef.current = await openRearCamera(video);
      setPhase("aiming");
    } catch {
      setError("Camera permission is needed to scan your sheet.");
      setPhase("error");
    }
  };

  const takePhoto = () => {
    const video = videoRef.current;
    if (!video) return;

    // Full resolution here, because these are the pixels a child ends up looking at.
    const result = captureFromFrame(grabFrame(video));
    if (!result.ok) {
      setReady(false);
      setHint(result.hint);
      return;
    }

    const canvas = toCanvas(result.texture);
    shotRef.current = {
      texture: encodeTexture(canvas).dataUrl,
      dino: result.code.dino,
      serial: result.code.serial,
    };

    const preview = previewRef.current;
    if (preview) {
      preview.width = canvas.width;
      preview.height = canvas.height;
      preview.getContext("2d")?.drawImage(canvas, 0, 0);
    }
    setPhase("captured");
  };

  const send = async () => {
    const shot = shotRef.current;
    if (!shot) return;

    setPhase("sending");
    try {
      const response = await fetch("/api/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session, ...shot }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "could not send");
      }
      setSentDino(DINOS[shot.dino as keyof typeof DINOS]?.name ?? shot.dino);
      setPhase("sent");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "could not send");
      setPhase("error");
    }
  };

  const backToAiming = () => {
    shotRef.current = null;
    setSentDino(null);
    setReady(false);
    setHint("Point the camera at the whole sheet");
    setPhase("aiming");
  };

  const showViewfinder = phase === "aiming";
  const showPreview = phase === "captured" || phase === "sending";

  return (
    <main style={shell}>
      <div style={stage}>
        <video
          ref={videoRef}
          playsInline
          muted
          style={{ ...videoStyle, visibility: showViewfinder ? "visible" : "hidden" }}
        />
        <canvas
          ref={overlayRef}
          style={{ ...overlayStyle, visibility: showViewfinder ? "visible" : "hidden" }}
        />

        <div style={{ ...previewWrap, display: showPreview ? "flex" : "none" }}>
          <canvas ref={previewRef} style={previewStyle} />
        </div>

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
            <button onClick={backToAiming} style={button}>
              Scan another
            </button>
          </div>
        ) : null}

        {phase === "error" ? (
          <div style={curtain}>
            <h2 style={{ margin: 0 }}>Something went wrong</h2>
            <p style={{ opacity: 0.8, textAlign: "center", maxWidth: 300 }}>{error}</p>
            <button onClick={phase === "error" && streamRef.current ? backToAiming : start} style={button}>
              Try again
            </button>
          </div>
        ) : null}
      </div>

      {showViewfinder ? (
        <footer style={bar}>
          <span style={{ ...hintText, color: ready ? "#3ddc84" : "#fff" }}>{hint}</span>
          <button onClick={takePhoto} style={{ ...shutter, opacity: ready ? 1 : 0.45 }}>
            Take photo
          </button>
        </footer>
      ) : null}

      {showPreview ? (
        <footer style={bar}>
          <span style={hintText}>
            {phase === "sending" ? "Sending…" : "Happy with it?"}
          </span>
          <div style={{ display: "flex", gap: 10 }}>
            <button onClick={backToAiming} style={secondary} disabled={phase === "sending"}>
              Retake
            </button>
            <button onClick={send} style={shutter} disabled={phase === "sending"}>
              {phase === "sending" ? "Sending…" : "Send it"}
            </button>
          </div>
        </footer>
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
const previewWrap: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
  background: "#0b0f0d",
};
const previewStyle: React.CSSProperties = {
  maxWidth: "100%",
  maxHeight: "100%",
  borderRadius: 12,
  background: "#fff",
};
const curtain: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 16,
  background: "rgba(8, 14, 11, 0.92)",
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
const shutter: React.CSSProperties = { ...button, padding: "14px 24px" };
const secondary: React.CSSProperties = {
  ...button,
  background: "rgba(255,255,255,0.14)",
  color: "#fff",
};
const bar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  padding: "14px 18px calc(14px + env(safe-area-inset-bottom))",
  background: "#101915",
};
const hintText: React.CSSProperties = {
  font: "600 15px/1.3 ui-sans-serif, system-ui, sans-serif",
};
