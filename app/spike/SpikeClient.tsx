"use client";

import { useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";
import creatureData from "@/world/creatures/triceratops.json";
import rigData from "@/world/rigs/triceratops.json";
import { compositeCreature } from "@/world/composite";
import { makeDemoColouring } from "@/world/demo";
import type { Rig } from "@/world/types";
import { makeCreature, type CreatureData } from "@/world3d/creature";
import { outlineMaterial, paperMaterial } from "@/world3d/toon";
import { Walk } from "@/world3d/walk";

/**
 * The spike: one dinosaur, inflated from the drawing, walking.
 *
 * Deliberately not wired into `/screen`. The question is whether a child's crayon on a
 * three dimensional body still reads as paper, and whether the hip survives a full
 * stride - both are answered by looking, so the cheapest thing that can be looked at is
 * the right thing to build. The shipped screen keeps working meanwhile.
 *
 *   ?demo=<n>    which stand-in colouring
 *   ?phase=<r>   freeze at one point in the stride, radians
 *   ?speed=<n>   0 stands still, 1 is a normal walking pace
 *   ?bare=1      no valley behind, for judging the silhouette on its own
 */
export default function SpikeClient() {
  const params = useSearchParams();
  const hostRef = useRef<HTMLDivElement>(null);

  const seed = Number(params.get("demo") ?? 3) || 3;
  const frozen = params.get("phase");
  const speed = params.get("speed") === null ? 1 : Number(params.get("speed")) || 0;
  const bare = params.get("bare") === "1";
  /** ?debug=normals paints the surface by its normals, where a fold is unmistakable. */
  const debug = params.get("debug");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let frame = 0;

    void (async () => {
      const THREE = await import("three");

      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(host.clientWidth, host.clientHeight, false);
      if (disposed) {
        renderer.dispose();
        return;
      }
      host.appendChild(renderer.domElement);

      const scene = new THREE.Scene();

      // The page's own coordinates, so nothing has to be converted twice: one unit is
      // one canonical texture pixel, and the camera looks straight down the view axis
      // the drawing was made along.
      const { w, h } = rigData.texture;
      const camera = new THREE.OrthographicCamera(0, w, 0, -h, -2000, 2000);
      const fit = () => {
        const width = host.clientWidth;
        const height = host.clientHeight;
        renderer.setSize(width, height, false);
        const scale = Math.min(width / w, height / h);
        const halfW = width / scale / 2;
        const halfH = height / scale / 2;
        camera.left = w / 2 - halfW;
        camera.right = w / 2 + halfW;
        camera.top = -h / 2 + halfH;
        camera.bottom = -h / 2 - halfH;
        camera.updateProjectionMatrix();
      };
      fit();

      const colouring = makeDemoColouring(seed);
      const sheet = await compositeCreature(rigData as Rig, colouring);
      const texture = new THREE.CanvasTexture(sheet);
      texture.colorSpace = THREE.SRGBColorSpace;

      const creature = await makeCreature(
        creatureData as CreatureData,
        debug === "normals"
          ? new THREE.MeshNormalMaterial({ flatShading: true })
          : paperMaterial(texture),
        outlineMaterial(6),
      );
      if (disposed) {
        renderer.dispose();
        return;
      }
      scene.add(creature.group);

      const walk = new Walk(creatureData as CreatureData, creature.bones);
      if (frozen !== null) walk.setPhase(Number(frozen) || 0, speed);

      const onResize = () => fit();
      window.addEventListener("resize", onResize);

      let last = performance.now();
      const tick = (now: number) => {
        if (disposed) return;
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        if (frozen === null) walk.advance(dt, speed);
        renderer.render(scene, camera);
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);

      // Told to the screenshot script, so it can wait for something real.
      (window as unknown as { spikeReady?: boolean }).spikeReady = true;

      return () => window.removeEventListener("resize", onResize);
    })();

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      host.replaceChildren();
    };
  }, [seed, frozen, speed, debug]);

  return (
    <div
      ref={hostRef}
      style={{
        position: "fixed",
        inset: 0,
        background: bare ? "#ffffff" : "#8fd0ea url(/assets/world/valley.webp) center/cover",
      }}
    />
  );
}
