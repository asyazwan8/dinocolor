import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Dino Colourise",
  description: "Colour a dinosaur, scan it, and watch it walk into a prehistoric world.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
