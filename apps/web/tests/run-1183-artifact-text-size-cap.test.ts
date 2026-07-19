import { afterEach, describe, expect, it, vi } from "vitest";

// #1183 hardening (codex adversarial review, round 2): api.runs.artifactText's
// maxBytes cap must not rely on Content-Length alone (the real download
// endpoint streams its response and does not always send that header -- see
// apps/api/services/run_access.py's StreamingResponse), and it must not
// buffer the entire body with res.text() before measuring it (that already
// pays the unbounded-allocation cost the cap exists to avoid). It must stream
// the real response body and abort as soon as the byte budget is exceeded.
//
// These tests exercise the real streaming Response body (Node's fetch
// Response provides an actual ReadableStream via `.body`), not a mock of
// artifactText itself, so they prove the enforcement actually works rather
// than just asserting it was called with the right arguments.

describe("api.runs.artifactText maxBytes enforcement (#1183 codex round 2)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("returns the text when the streamed body is within the cap", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("# Report\n\nAll good.", {
        status: 200,
        headers: { "content-type": "text/markdown" },
      }),
    );

    const { api } = await import("@/lib/api");
    const text = await api.runs.artifactText("run_1", "artifact_1", { maxBytes: 1024 });
    expect(text).toBe("# Report\n\nAll good.");
  });

  it("rejects a streamed body that exceeds maxBytes even with no Content-Length header", async () => {
    const oversized = "x".repeat(2000);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      // Deliberately no content-length header -- matches the real
      // StreamingResponse download endpoint.
      new Response(oversized, { status: 200, headers: { "content-type": "text/plain" } }),
    );

    const { api } = await import("@/lib/api");
    await expect(api.runs.artifactText("run_1", "artifact_1", { maxBytes: 256 })).rejects.toThrow(
      /exceeds inline preview size limit/i,
    );
  });

  it("rejects based on the real streamed bytes even when Content-Length is spoofed/understated", async () => {
    const oversized = "y".repeat(2000);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(oversized, {
        status: 200,
        headers: { "content-type": "text/plain", "content-length": "10" },
      }),
    );

    const { api } = await import("@/lib/api");
    await expect(api.runs.artifactText("run_1", "artifact_1", { maxBytes: 256 })).rejects.toThrow(
      /exceeds inline preview size limit/i,
    );
  });

  it("does not enforce any cap when maxBytes is omitted (existing callers unaffected)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("x".repeat(5000), { status: 200 }));

    const { api } = await import("@/lib/api");
    const text = await api.runs.artifactText("run_1", "artifact_1");
    expect(text.length).toBe(5000);
  });
});
