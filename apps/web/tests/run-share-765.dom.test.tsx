import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { StandaloneShareCard } from "@/app/s/[token]/StandaloneShareCard";
import type { StandaloneShare } from "@/lib/types";

// #765: run share recipient card + api wiring.

describe("StandaloneShareCard run branch (#765)", () => {
  it("renders the run result, status and files", () => {
    const share: StandaloneShare = {
      entity_type: "run",
      title: "Run · Alpha",
      files: [],
      run: {
        run_id: "run-1",
        worker_id: "alpha",
        worker_name: "Alpha",
        status: "completed",
        result: "Hello output",
        files: [{ name: "summary.md" }],
      },
    };
    render(<StandaloneShareCard share={share} token="fls_abc" authed />);
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("completed")).toBeInTheDocument();
    expect(screen.getByText("Hello output")).toBeInTheDocument();
    expect(screen.getByText("summary.md")).toBeInTheDocument();
    expect(screen.getByText("↑ Open worker")).toBeInTheDocument();
  });
});

describe("api.runs share (#765)", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue({
      ok: true, status: 200, headers: { get: () => "application/json" },
      text: async () => JSON.stringify({ url: "https://x/s/fls_abc", token: "fls_abc" }),
      json: async () => ({ url: "https://x/s/fls_abc", token: "fls_abc" }),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("shareLink POSTs and revokeShareLink DELETEs the run share route", async () => {
    const { api } = await import("@/lib/api");
    await api.runs.shareLink("run-1");
    expect(String(fetchMock.mock.calls[0][0])).toContain("/runs/run-1/share-link");
    expect(fetchMock.mock.calls[0][1].method).toBe("POST");

    fetchMock.mockClear();
    fetchMock.mockResolvedValue({ ok: true, status: 204, headers: { get: () => null }, text: async () => "", json: async () => null });
    await api.runs.revokeShareLink("run-1");
    expect(fetchMock.mock.calls[0][1].method).toBe("DELETE");
  });
});
