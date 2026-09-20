import { Suspense } from "react";
import SpikeClient from "./SpikeClient";

export const metadata = { title: "Dino Colourise - 3D spike" };

export default function SpikePage() {
  return (
    <Suspense>
      <SpikeClient />
    </Suspense>
  );
}
