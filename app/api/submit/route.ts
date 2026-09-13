import { NextResponse } from "next/server";
import { getBus } from "@/lib/relay/bus";
import { sanitizeSession, type DinoEvent } from "@/lib/relay/types";
import { isDinoType } from "@/lib/sheet/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A rectified 1200x800 sheet as WebP lands around 70-130KB, so roughly 175KB of
 * base64. The ceiling is generous enough for a detailed capture and low enough that
 * the endpoint cannot be used to push large payloads through the relay.
 */
const MAX_TEXTURE_CHARS = 500_000;

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
  if (typeof texture !== "string" || !texture.startsWith("data:image/webp;base64,")) {
    return NextResponse.json({ error: "expected a webp data URL" }, { status: 400 });
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
