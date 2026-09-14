import type { DinoType } from "@/lib/sheet/types";

/** One scanned sheet on its way to the screen. */
export interface DinoEvent {
  id: string;
  dino: DinoType;
  serial: string;
  /** Data URL of the rectified canonical texture; WebP, JPEG or PNG. */
  texture: string;
  ts: number;
}

/**
 * Nothing is persisted. Keys live exactly long enough for a screen that reconnects
 * mid-session to catch up, and then expire on their own.
 */
export const RELAY_TTL_SECONDS = 60;

/** Matches the on-screen cap: replaying more than the screen can show is wasted work. */
export const RELAY_BACKLOG = 10;

export const DEFAULT_SESSION = "main";

export function sanitizeSession(value: string | null | undefined): string {
  if (!value) return DEFAULT_SESSION;
  const trimmed = value.trim().toLowerCase().slice(0, 32);
  return /^[a-z0-9_-]+$/.test(trimmed) ? trimmed : DEFAULT_SESSION;
}
