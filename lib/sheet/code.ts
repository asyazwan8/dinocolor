import { isDinoType, type DinoType } from "./types";

/**
 * Version prefix on every sheet. Printed stock outlives code, so a sheet printed
 * today must still be identifiable after the payload format changes. Bump this and
 * old sheets are cleanly rejected rather than silently misread.
 */
export const SHEET_CODE_VERSION = "DC1";

export interface SheetCode {
  version: string;
  dino: DinoType;
  serial: string;
}

const SERIAL_RE = /^[A-Za-z0-9]{1,8}$/;

export function formatSheetCode(dino: DinoType, serial: string): string {
  return `${SHEET_CODE_VERSION}|${dino}|${serial}`;
}

/** Returns null for anything that is not one of our sheets. */
export function parseSheetCode(raw: string): SheetCode | null {
  const parts = raw.trim().split("|");
  if (parts.length !== 3) return null;

  const [version, dino, serial] = parts;
  if (version !== SHEET_CODE_VERSION) return null;
  if (!isDinoType(dino)) return null;
  if (!SERIAL_RE.test(serial)) return null;

  return { version, dino, serial };
}
