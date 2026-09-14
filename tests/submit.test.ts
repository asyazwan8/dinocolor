import { describe, expect, it } from "vitest";
import { POST } from "@/app/api/submit/route";

const TINY = "UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==";

function submit(body: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/api/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const valid = {
  session: "submit-test",
  dino: "TRI",
  serial: "0001",
  texture: `data:image/webp;base64,${TINY}`,
};

describe("submit validation", () => {
  it("accepts a well-formed capture", async () => {
    const response = await submit(valid);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
  });

  /**
   * Every format a phone can actually produce.
   *
   * A canvas asked for a type it cannot encode silently returns PNG instead, so
   * accepting WebP alone rejects good captures from any device without a WebP
   * encoder - which is how this first broke, on a real phone, after passing every
   * test in a Chromium that happens to have one.
   */
  it.each(["image/webp", "image/jpeg", "image/png"])("accepts %s", async (type) => {
    const response = await submit({ ...valid, texture: `data:${type};base64,${TINY}` });
    expect(response.status).toBe(200);
  });

  it.each([
    ["a non-image data URL", "data:text/html;base64,PGI+"],
    ["an unsupported image type", "data:image/gif;base64,R0lGOD"],
    ["a bare URL", "https://example.com/sheet.webp"],
    ["something that is not a string", 42],
  ])("rejects %s", async (_label, texture) => {
    const response = await submit({ ...valid, texture });
    expect(response.status).toBe(400);
  });

  it("rejects an unknown species", async () => {
    expect((await submit({ ...valid, dino: "VEL" })).status).toBe(400);
  });

  it("rejects a malformed serial", async () => {
    expect((await submit({ ...valid, serial: "00-01" })).status).toBe(400);
  });

  it("rejects a texture too large to relay", async () => {
    const huge = `data:image/jpeg;base64,${"A".repeat(700_000)}`;
    expect((await submit({ ...valid, texture: huge })).status).toBe(413);
  });

  it("rejects a body that is not JSON", async () => {
    const response = await POST(
      new Request("http://localhost/api/submit", { method: "POST", body: "not json" }),
    );
    expect(response.status).toBe(400);
  });
});
