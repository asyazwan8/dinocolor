import Link from "next/link";
import { DINOS } from "@/lib/sheet/types";

export default function Home() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "48px 24px" }}>
      <h1 style={{ fontSize: 40, margin: "0 0 8px" }}>Dino Colourise</h1>
      <p style={{ color: "var(--muted)", fontSize: 18, marginTop: 0 }}>
        Colour a dinosaur, scan it, and watch it walk into a prehistoric world.
      </p>

      <h2 style={{ fontSize: 20, marginTop: 40 }}>Colouring sheets</h2>
      <p style={{ color: "var(--muted)", marginTop: 4 }}>
        Print on A4, landscape, at 100% scale. Do not tick &ldquo;fit to page&rdquo; &mdash;
        scaling moves the box away from where the scanner expects it.
      </p>
      <ul>
        {Object.values(DINOS).map((dino) => (
          <li key={dino.code} style={{ margin: "6px 0" }}>
            <Link href={`/print/${dino.slug}`}>{dino.name}</Link>{" "}
            <span style={{ color: "var(--muted)" }}>
              &middot; <Link href={`/print/${dino.slug}?count=20`}>20 numbered sheets</Link>
            </span>
          </li>
        ))}
      </ul>

      <h2 style={{ fontSize: 20, marginTop: 40 }}>Running the installation</h2>
      <ul>
        <li style={{ margin: "6px 0" }}>
          <Link href="/screen">Big screen</Link> &mdash; the 16:9 world display
        </li>
        <li style={{ margin: "6px 0" }}>
          <Link href="/scan">Phone scanner</Link> &mdash; opened from the screen&rsquo;s QR
        </li>
        <li style={{ margin: "6px 0" }}>
          <Link href="/dev/rectify">Rectify harness</Link> &mdash; tuning tool for captures
        </li>
      </ul>
    </main>
  );
}
