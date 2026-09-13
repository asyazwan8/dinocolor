import Redis from "ioredis";
import { RELAY_BACKLOG, RELAY_TTL_SECONDS, type DinoEvent } from "./types";

/**
 * The relay between a phone and the screen.
 *
 * Deliberately not a database. A photograph is never written to disk; it sits in a
 * keyspace with a 60 second TTL purely so a screen that reconnects can catch up on
 * what it missed, and then it is gone.
 */
export interface Bus {
  publish(session: string, event: DinoEvent): Promise<void>;
  /** Replay buffer, oldest first. */
  recent(session: string): Promise<DinoEvent[]>;
  subscribe(session: string, onEvent: (event: DinoEvent) => void): Promise<() => void>;
}

const channel = (session: string) => `dc:ch:${session}`;
const backlogKey = (session: string) => `dc:recent:${session}`;

class RedisBus implements Bus {
  constructor(private readonly url: string) {}

  private publisher?: Redis;

  private pub(): Redis {
    this.publisher ??= new Redis(this.url, { maxRetriesPerRequest: 3, lazyConnect: false });
    return this.publisher;
  }

  async publish(session: string, event: DinoEvent): Promise<void> {
    const payload = JSON.stringify(event);
    const key = backlogKey(session);
    await this.pub()
      .multi()
      .lpush(key, payload)
      .ltrim(key, 0, RELAY_BACKLOG - 1)
      .expire(key, RELAY_TTL_SECONDS)
      .publish(channel(session), payload)
      .exec();
  }

  async recent(session: string): Promise<DinoEvent[]> {
    const raw = await this.pub().lrange(backlogKey(session), 0, RELAY_BACKLOG - 1);
    return raw.reverse().flatMap(parseEvent);
  }

  async subscribe(session: string, onEvent: (event: DinoEvent) => void): Promise<() => void> {
    // A subscriber connection cannot issue other commands, so it gets its own.
    const sub = new Redis(this.url, { maxRetriesPerRequest: null });
    await sub.subscribe(channel(session));
    sub.on("message", (_channel, message) => {
      for (const event of parseEvent(message)) onEvent(event);
    });
    return () => {
      void sub.quit().catch(() => sub.disconnect());
    };
  }
}

/**
 * Fallback for local development, where standing up Redis to watch one dinosaur walk
 * across a screen is friction for no benefit. Next dev runs a single process, so an
 * in-process bus behaves identically from the caller's point of view. It is not
 * viable in production, where each serverless invocation is its own process.
 */
class MemoryBus implements Bus {
  private readonly backlog = new Map<string, DinoEvent[]>();
  private readonly listeners = new Map<string, Set<(event: DinoEvent) => void>>();

  private prune(session: string): DinoEvent[] {
    const cutoff = Date.now() - RELAY_TTL_SECONDS * 1000;
    const kept = (this.backlog.get(session) ?? []).filter((e) => e.ts >= cutoff);
    this.backlog.set(session, kept.slice(-RELAY_BACKLOG));
    return this.backlog.get(session) as DinoEvent[];
  }

  async publish(session: string, event: DinoEvent): Promise<void> {
    this.prune(session).push(event);
    this.prune(session);
    for (const listener of this.listeners.get(session) ?? []) listener(event);
  }

  async recent(session: string): Promise<DinoEvent[]> {
    return [...this.prune(session)];
  }

  async subscribe(session: string, onEvent: (event: DinoEvent) => void): Promise<() => void> {
    const set = this.listeners.get(session) ?? new Set();
    set.add(onEvent);
    this.listeners.set(session, set);
    return () => {
      set.delete(onEvent);
    };
  }
}

function parseEvent(raw: string): DinoEvent[] {
  try {
    const parsed = JSON.parse(raw) as DinoEvent;
    return parsed && typeof parsed.id === "string" ? [parsed] : [];
  } catch {
    return [];
  }
}

let cached: Bus | undefined;

export function getBus(): Bus {
  if (!cached) {
    const url = process.env.REDIS_URL ?? process.env.UPSTASH_REDIS_URL;
    cached = url ? new RedisBus(url) : new MemoryBus();
  }
  return cached;
}

export function isRelayPersistent(): boolean {
  return Boolean(process.env.REDIS_URL ?? process.env.UPSTASH_REDIS_URL);
}
