import { getBus } from "@/lib/relay/bus";
import { sanitizeSession, type DinoEvent } from "@/lib/relay/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Well inside any proxy idle timeout, so an idle screen is never quietly dropped. */
const HEARTBEAT_MS = 15_000;

export async function GET(request: Request) {
  const session = sanitizeSession(new URL(request.url).searchParams.get("s"));
  const bus = getBus();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };
      const send = (event: DinoEvent) => write(`data: ${JSON.stringify(event)}\n\n`);

      // Tell the browser to come back quickly. The platform will time this function
      // out eventually, and a screen that stops listening is the whole installation
      // going dark, so reconnecting fast matters more than saving a request.
      write("retry: 2000\n\n");

      // Replay first, so a screen that reconnects mid-session is repopulated rather
      // than sitting empty until the next child scans.
      for (const event of await bus.recent(session)) send(event);

      const unsubscribe = await bus.subscribe(session, send);
      const heartbeat = setInterval(() => write(": ping\n\n"), HEARTBEAT_MS);

      const shutdown = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed by the platform */
        }
      };

      request.signal.addEventListener("abort", shutdown);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-store, no-transform",
      connection: "keep-alive",
      // Nginx and friends buffer streamed responses by default, which would hold
      // dinosaurs back until the buffer filled.
      "x-accel-buffering": "no",
    },
  });
}
