/** The four species. Codes are what the QR payload carries. */
export const DINO_TYPES = ["TRI", "STE", "TRX", "BRA"] as const;
export type DinoType = (typeof DINO_TYPES)[number];

export interface DinoSpec {
  code: DinoType;
  /** URL slug used by /print/[dino] */
  slug: string;
  name: string;
  /** Real-world body length, the basis for on-screen scale. */
  lengthM: number;
}

export const DINOS: Record<DinoType, DinoSpec> = {
  TRI: { code: "TRI", slug: "triceratops", name: "Triceratops", lengthM: 8 },
  STE: { code: "STE", slug: "stegosaurus", name: "Stegosaurus", lengthM: 9 },
  TRX: { code: "TRX", slug: "t-rex", name: "T-rex", lengthM: 12 },
  BRA: { code: "BRA", slug: "brachiosaurus", name: "Brachiosaurus", lengthM: 22 },
};

/** Largest species defines scale 1.0. */
const REFERENCE_LENGTH_M = 22;

/**
 * Compress real length onto screen scale.
 *
 * A linear mapping would render Triceratops at 0.36 of Brachiosaurus, small enough
 * that a child's colouring stops being readable. The 0.75 power curve preserves the
 * ordering and the sense of "one of these is enormous" while keeping the small
 * species legible.
 */
export function dinoScale(dino: DinoType): number {
  return (DINOS[dino].lengthM / REFERENCE_LENGTH_M) ** 0.75;
}

export function isDinoType(value: string): value is DinoType {
  return (DINO_TYPES as readonly string[]).includes(value);
}

export function dinoBySlug(slug: string): DinoSpec | null {
  return Object.values(DINOS).find((d) => d.slug === slug) ?? null;
}
