import { Suspense } from "react";
import ScreenClient from "./ScreenClient";

export const metadata = { title: "Dino Colourise — Screen" };

export default function ScreenPage() {
  return (
    <Suspense fallback={<div style={{ background: "#000", width: "100vw", height: "100vh" }} />}>
      <ScreenClient />
    </Suspense>
  );
}
