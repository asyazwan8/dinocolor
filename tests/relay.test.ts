import { afterEach, describe, expect, it, vi } from "vitest";
import { getBus } from "@/lib/relay/bus";
import {
  DEFAULT_SESSION,
  RELAY_BACKLOG,
  RELAY_TTL_SECONDS,
  sanitizeSession,
  type DinoEvent,
} from "@/lib/relay/types";

function makeEvent(id: string, ts = Date.now()): DinoEvent {
  return { id, dino: "TRI", serial: "0001", texture: "data:image/webp;base64,UklGRg==", ts };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("sanitizeSession", () => {
  it("keeps a simple session name", () => {
    expect(sanitizeSession("gallery-2")).toBe("gallery-2");
  });

  it("lowercases and trims", () => {
    expect(sanitizeSession("  Gallery_2  ")).toBe("gallery_2");
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["empty", ""],
    ["path traversal", "../../etc"],
    ["a redis glob", "sess*"],
    ["a colon, which would forge a key prefix", "a:b"],
  ])("falls back to the default session for %s", (_label, input) => {
    expect(sanitizeSession(input)).toBe(DEFAULT_SESSION);
  });

  it("caps the length", () => {
    expect(sanitizeSession("x".repeat(80))).toHaveLength(32);
  });
});

describe("relay bus", () => {
  it("delivers a published event to a subscriber", async () => {
    const bus = getBus();
    const received: DinoEvent[] = [];
    const stop = await bus.subscribe("s-live", (e) => received.push(e));

    await bus.publish("s-live", makeEvent("a"));
    stop();
    await bus.publish("s-live", makeEvent("b"));

    expect(received.map((e) => e.id)).toEqual(["a"]);
  });

  it("keeps sessions isolated from each other", async () => {
    const bus = getBus();
    const received: string[] = [];
    const stop = await bus.subscribe("s-one", (e) => received.push(e.id));

    await bus.publish("s-two", makeEvent("elsewhere"));
    await bus.publish("s-one", makeEvent("mine"));
    stop();

    expect(received).toEqual(["mine"]);
  });

  it("replays recent events to a screen that reconnects", async () => {
    const bus = getBus();
    await bus.publish("s-replay", makeEvent("first"));
    await bus.publish("s-replay", makeEvent("second"));

    expect((await bus.recent("s-replay")).map((e) => e.id)).toEqual(["first", "second"]);
  });

  it("caps the backlog at what the screen can show", async () => {
    const bus = getBus();
    for (let i = 0; i < RELAY_BACKLOG + 6; i++) {
      await bus.publish("s-cap", makeEvent(`e${i}`));
    }

    const recent = await bus.recent("s-cap");
    expect(recent).toHaveLength(RELAY_BACKLOG);
    // Oldest dropped, newest kept, still in order.
    expect(recent[recent.length - 1].id).toBe(`e${RELAY_BACKLOG + 5}`);
  });

  it("forgets events once they age past the relay window", async () => {
    vi.useFakeTimers();
    const bus = getBus();

    await bus.publish("s-ttl", makeEvent("stale"));
    expect(await bus.recent("s-ttl")).toHaveLength(1);

    vi.setSystemTime(Date.now() + (RELAY_TTL_SECONDS + 5) * 1000);
    expect(await bus.recent("s-ttl")).toHaveLength(0);
  });
});
