import { NextResponse } from "next/server";
import { getBus } from "@/lib/relay/bus";
import { sanitizeSession, type DinoEvent } from "@/lib/relay/types";
import { isDinoType } from "@/lib/sheet/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A rectified 1200x800 sheet is around 70-130KB as WebP and up to about 250KB as
 * JPEG, so roughly 340KB of base64 at worst. The ceiling is generous enough for a
 * detailed capture on either, and low enough that the endpoint cannot be used to
 * push large payloads through the relay.
 */
const MAX_TEXTURE_CHARS = 600_000;

/**
 * Formats a phone may send.
 *
 * Not WebP alone: a canvas asked for a type it cannot encode silently returns PNG
 * instead, so insisting on WebP rejects perfectly good captures from any device
 * that cannot encode it. The size ceiling above, not the format, is what keeps
 * payloads sane.
 */
const ALLOWED_TEXTURE_TYPES = ["image/webp", "image/jpeg", "image/png"] as const;

const SERIAL_RE = /^[A-Za-z0-9]{1,8}$/;

interface SubmitBody {
  session?: string;
  dino?: string;
  serial?: string;
  texture?: string;
}

export async function POST(request: Request) {
  let body: SubmitBody;
  try {
    body = (await request.json()) as SubmitBody;
  } catch {
    return NextResponse.json({ error: "expected JSON" }, { status: 400 });
  }

  const { dino, serial, texture } = body;

  if (typeof dino !== "string" || !isDinoType(dino)) {
    return NextResponse.json({ error: "unknown dino" }, { status: 400 });
  }
  if (typeof serial !== "string" || !SERIAL_RE.test(serial)) {
    return NextResponse.json({ error: "bad serial" }, { status: 400 });
  }
  if (
    typeof texture !== "string" ||
    !ALLOWED_TEXTURE_TYPES.some((type) => texture.startsWith(`data:${type};base64,`))
  ) {
    return NextResponse.json(
      { error: `expected one of ${ALLOWED_TEXTURE_TYPES.join(", ")} as a data URL` },
      { status: 400 },
    );
  }
  if (texture.length > MAX_TEXTURE_CHARS) {
    return NextResponse.json({ error: "texture too large" }, { status: 413 });
  }

  const event: DinoEvent = {
    id: crypto.randomUUID(),
    dino,
    serial,
    texture,
    ts: Date.now(),
  };

  await getBus().publish(sanitizeSession(body.session), event);

  // The texture is not echoed back: the phone already has it, and there is nothing
  // to look up later because nothing is kept.
  return NextResponse.json({ ok: true, id: event.id });
}
