import type { DinoEvent } from "./types";

/**
 * Screen-side consumer.
 *
 * The platform will time the streaming function out, so disconnects are routine
 * rather than exceptional: reconnect handling is built in from the start, and the
 * replay buffer means a reconnect re-delivers whatever arrived during the gap.
 * Replay makes duplicates normal too, so ids are tracked and repeats dropped.
 */
export interface RelayClientOptions {
  session: string;
  onDino: (event: DinoEvent) => void;
  onStatus?: (status: "connecting" | "live" | "retrying") => void;
}

export function connectRelay(options: RelayClientOptions): () => void {
  const seen = new Set<string>();
  let source: EventSource | null = null;
  let stopped = false;

  const open = () => {
    if (stopped) return;
    options.onStatus?.(source ? "retrying" : "connecting");

    source = new EventSource(`/api/stream?s=${encodeURIComponent(options.session)}`);

    source.onopen = () => options.onStatus?.("live");

    source.onmessage = (message) => {
      let event: DinoEvent;
      try {
        event = JSON.parse(message.data) as DinoEvent;
      } catch {
        return;
      }
      if (!event?.id || seen.has(event.id)) return;

      // Bounded, because the page runs for the length of an exhibition. The cap sits
      // well above the replay buffer, so a genuine duplicate is always still known.
      seen.add(event.id);
      if (seen.size > 500) {
        for (const id of [...seen].slice(0, 200)) seen.delete(id);
      }

      options.onDino(event);
    };

    // EventSource reconnects on its own, honouring the retry directive; this only
    // surfaces the state so the screen can show it.
    source.onerror = () => options.onStatus?.("retrying");
  };

  open();

  return () => {
    stopped = true;
    source?.close();
  };
}
