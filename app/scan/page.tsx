import { Suspense } from "react";
import ScanClient from "./ScanClient";

export const metadata = { title: "Dino Colourise — Scan" };

export default function ScanPage() {
  return (
    <Suspense fallback={null}>
      <ScanClient />
    </Suspense>
  );
}
