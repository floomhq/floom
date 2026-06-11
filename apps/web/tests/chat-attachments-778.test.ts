import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildMessageWithAttachments } from "@/lib/emily/attachments";

// #778: attachment text rides along in the message; upload posts FormData.

describe("buildMessageWithAttachments (#778)", () => {
  it("appends text-file content under a labelled header", () => {
    const out = buildMessageWithAttachments("summarise this", [
      { name: "notes.md", text: "hello world" },
    ]);
    expect(out).toBe("summarise this\n\n[Attached file: notes.md]\nhello world");
  });
  it("ignores files without text (binaries)", () => {
    expect(buildMessageWithAttachments("hi", [{ name: "logo.png", text: null }])).toBe("hi");
  });
  it("returns the bare message when there are no files", () => {
    expect(buildMessageWithAttachments("hi")).toBe("hi");
  });
});

describe("api.chat.uploadAttachments (#778)", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue({
      ok: true, status: 200,
      json: async () => [{ name: "a.txt", size: 3, type: "text/plain", text: "abc" }],
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs multipart FormData to /chat/attachments", async () => {
    const { api } = await import("@/lib/api");
    const file = new File(["abc"], "a.txt", { type: "text/plain" });
    const out = await api.chat.uploadAttachments([file]);
    expect(out[0].text).toBe("abc");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/chat/attachments");
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
  });
});
