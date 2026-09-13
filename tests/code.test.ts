import { describe, expect, it } from "vitest";
import { formatSheetCode, parseSheetCode } from "@/lib/sheet/code";
import { DINOS, dinoBySlug, dinoScale } from "@/lib/sheet/types";

describe("sheet code", () => {
  it("parses a well-formed payload", () => {
    expect(parseSheetCode("DC1|TRI|0042")).toEqual({
      version: "DC1",
      dino: "TRI",
      serial: "0042",
    });
  });

  it("round-trips through format", () => {
    expect(parseSheetCode(formatSheetCode("BRA", "A7"))).toEqual({
      version: "DC1",
      dino: "BRA",
      serial: "A7",
    });
  });

  it("tolerates surrounding whitespace from the decoder", () => {
    expect(parseSheetCode("  DC1|STE|1 ")).not.toBeNull();
  });

  it.each([
    ["an unknown version", "DC0|TRI|0042"],
    ["an unknown species", "DC1|VEL|0042"],
    ["too few fields", "DC1|TRI"],
    ["too many fields", "DC1|TRI|0042|X"],
    ["an empty serial", "DC1|TRI|"],
    ["an over-long serial", "DC1|TRI|123456789"],
    ["a non-alphanumeric serial", "DC1|TRI|00-42"],
    ["an unrelated QR code", "https://example.com"],
    ["empty input", ""],
  ])("rejects %s", (_label, raw) => {
    expect(parseSheetCode(raw)).toBeNull();
  });
});

describe("dino specs", () => {
  it("scales the reference species to 1.0", () => {
    expect(dinoScale("BRA")).toBeCloseTo(1, 10);
  });

  it("preserves size ordering", () => {
    expect(dinoScale("BRA")).toBeGreaterThan(dinoScale("TRX"));
    expect(dinoScale("TRX")).toBeGreaterThan(dinoScale("STE"));
    expect(dinoScale("STE")).toBeGreaterThan(dinoScale("TRI"));
  });

  it("keeps the smallest species legible rather than linearly tiny", () => {
    const linear = DINOS.TRI.lengthM / DINOS.BRA.lengthM;
    expect(dinoScale("TRI")).toBeGreaterThan(linear);
    expect(dinoScale("TRI")).toBeGreaterThan(0.4);
  });

  it("resolves slugs, and rejects unknown ones", () => {
    expect(dinoBySlug("triceratops")?.code).toBe("TRI");
    expect(dinoBySlug("velociraptor")).toBeNull();
  });

  it("gives every species a unique slug", () => {
    const slugs = Object.values(DINOS).map((d) => d.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});
