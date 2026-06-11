import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { InlineFileOpen } from "@/components/file-viewer/InlineFileOpen";

// #780: brain file tags render as chips in the file list; saveTextFile forwards tags.

describe("InlineFileOpen tags (#780)", () => {
  it("renders tag chips for a file", () => {
    render(
      <InlineFileOpen
        rootLabel="alpha"
        files={[{ id: "notes.txt", name: "notes.txt", url: "#", tags: ["policy", "hr"] }]}
      />
    );
    expect(screen.getByText("policy")).toBeInTheDocument();
    expect(screen.getByText("hr")).toBeInTheDocument();
  });
});

describe("api.contexts.saveTextFile tags (#780)", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue({
      ok: true, status: 200, headers: { get: () => "application/json" },
      text: async () => "{}", json: async () => ({}),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("includes tags in the body when given", async () => {
    const { api } = await import("@/lib/api");
    await api.contexts.saveTextFile("alpha", "notes.txt", "hi", ["policy"]);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ content: "hi", tags: ["policy"] });
  });

  it("omits tags when not given", async () => {
    const { api } = await import("@/lib/api");
    await api.contexts.saveTextFile("alpha", "notes.txt", "hi");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ content: "hi" });
  });
});
