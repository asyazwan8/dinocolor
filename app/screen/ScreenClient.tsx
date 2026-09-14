"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import QRCode from "qrcode";
import { connectRelay } from "@/lib/relay/client";
import { sanitizeSession } from "@/lib/relay/types";
import type { DinoType } from "@/lib/sheet/types";
import rigData from "@/world/rigs/triceratops.json";
import { decodeTexture } from "@/world/composite";
import { makeDemoColouring } from "@/world/demo";
import { loadBackdrop } from "@/world/procedural";
import type { Rig } from "@/world/types";
import { World, fitStage } from "@/world/World";

type Status = "connecting" | "live" | "retrying";

export default function ScreenClient() {
  const params = useSearchParams();
  const session = sanitizeSession(params.get("s"));
  const demoCount = Math.min(10, Math.max(0, Number(params.get("demo") ?? 0) || 0));

  const hostRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<World | null>(null);
  const [status, setStatus] = useState<Status>("connecting");
  const [joinQr, setJoinQr] = useState<string>("");
  const [count, setCount] = useState(0);

  useEffect(() => {
    const url = `${window.location.origin}/scan?s=${encodeURIComponent(session)}`;
    void QRCode.toDataURL(url, { margin: 1, width: 260, errorCorrectionLevel: "M" }).then(setJoinQr);
  }, [session]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let cleanupRelay: (() => void) | undefined;
    let onResize: (() => void) | undefined;

    void (async () => {
      // Pixi is a large dependency and only the screen needs it, so it is loaded
      // here rather than pulled into every page's bundle.
      const { Application } = await import("pixi.js");
      const app = new Application();
      await app.init({
        background: "#8fd0ea",
        resizeTo: host,
        antialias: true,
        // A projector or wall display gains nothing from a 3x framebuffer and pays
        // for it in fill rate with ten rigs on screen.
        resolution: Math.min(window.devicePixelRatio || 1, 2),
        autoDensity: true,
      });
      if (disposed) {
        app.destroy(true);
        return;
      }

      host.appendChild(app.canvas);

      const world = new World(app, {
        rig: rigData as Rig,
        backdrop: await loadBackdrop(),
      });
      worldRef.current = world;

      fitStage(app);
      onResize = () => fitStage(app);
      window.addEventListener("resize", onResize);

      for (let i = 0; i < demoCount; i++) {
        // Placed in frame rather than walking in, so a preview shows the valley
        // populated immediately.
        await world.addDino(
          `demo-${i}`,
          "TRI",
          makeDemoColouring(i * 7717 + 11),
          0.08 + (i / Math.max(1, demoCount - 1)) * 0.84,
        );
      }
      setCount(world.count);

      cleanupRelay = connectRelay({
        session,
        onStatus: setStatus,
        onDino: (event) => {
          void (async () => {
            try {
              const image = await decodeTexture(event.texture);
              await world.addDino(event.id, event.dino as DinoType, image);
              setCount(world.count);
            } catch (error) {
              // A corrupt payload must not take the installation down; the next
              // child's scan should still work. It is still worth saying so: a
              // silent swallow here looks exactly like a dead relay.
              console.error("could not add dinosaur", error);
            }
          })();
        },
      });
    })();

    return () => {
      disposed = true;
      cleanupRelay?.();
      if (onResize) window.removeEventListener("resize", onResize);
      worldRef.current?.destroy();
      worldRef.current = null;
      host.replaceChildren();
    };
  }, [session, demoCount]);

  return (
    <div style={{ position: "fixed", inset: 0, background: "#000", overflow: "hidden" }}>
      <div ref={hostRef} style={{ position: "absolute", inset: 0 }} />

      <aside style={panel}>
        {joinQr ? <img src={joinQr} alt="Scan to join" style={{ width: 112, height: 112, borderRadius: 8 }} /> : null}
        <div>
          <div style={{ fontWeight: 700, fontSize: 15 }}>Scan your dinosaur</div>
          <div style={{ opacity: 0.72, fontSize: 13, marginTop: 2 }}>
            {count} in the valley
          </div>
          <div style={{ opacity: 0.55, fontSize: 12, marginTop: 2 }}>
            {status === "live" ? "connected" : status}
          </div>
        </div>
      </aside>
    </div>
  );
}

const panel: React.CSSProperties = {
  position: "absolute",
  right: 24,
  bottom: 24,
  display: "flex",
  gap: 14,
  alignItems: "center",
  padding: 14,
  borderRadius: 14,
  background: "rgba(12, 24, 18, 0.55)",
  color: "#fff",
  backdropFilter: "blur(8px)",
  font: "500 14px/1.35 ui-sans-serif, system-ui, sans-serif",
};
