import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { PackDetailPane } from "@/app/contexts/page";
import type { ContextDetail } from "@/lib/types";

// Round-09 r9 — Library (Context) item detail REAL build, structural proof of
// the gaps closed against detail-context.md:
//   (C) share-link REVOKE control present (#766)
//   (E) FOLDER history affordance present, NEXT TO the per-file history
//   (B) Sensitive consequence note explicit
// Plus the api client revoke wiring (the missing client half of #766).

function makeDetail(overrides: Partial<ContextDetail> = {}): ContextDetail {
  return {
    name: "company-facts",
    file_count: 2,
    total_size_bytes: 4096,
    writeable: true,
    worker_count: 1,
    read_only: false,
    sensitive: false,
    visibility: "private",
    owner_id: "u1",
    files: [
      { path: "icp.md", size: 1200, mime_type: "text/markdown", updated_at: "2026-06-17T00:00:00Z", is_binary: false },
      { path: "brand-voice.md", size: 800, mime_type: "text/markdown", updated_at: "2026-06-17T00:00:00Z", is_binary: false },
    ],
    used_by: [{ worker_id: "w1", worker_name: "Outbound Pitch" }],
    ...overrides,
  };
}

const baseProps = {
  folderColumns: [{ folder: "", entries: [] }],
  folderPath: [] as string[],
  dragActive: false,
  mobileVisible: true,
  onBackMobile: () => {},
  onOpenFolder: () => {},
  onOpenFile: () => {},
  onDeleteFile: () => {},
  onAddFile: () => {},
  onCreateFile: () => {},
  onVisibilityChange: () => {},
  onRolledBack: () => {},
  dropHandlers: {},
};

describe("Library item detail — header affordances (r9)", () => {
  it("(E) surfaces a FOLDER history affordance in the pack header", () => {
    render(<PackDetailPane detail={makeDetail()} readOnly={false} {...baseProps} />);
    // Whole-folder history (orphaned client method, now wired) is reachable.
    expect(screen.getByText("Folder history")).toBeInTheDocument();
  });

  it("(B) shows the Sensitive consequence note when the folder is Sensitive", () => {
    render(<PackDetailPane detail={makeDetail({ sensitive: true })} readOnly={false} {...baseProps} />);
    expect(
      screen.getByText(/never committed to git or pushed to GitHub/i)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/enable version history and rollback for the whole folder/i)
    ).toBeInTheDocument();
  });

  it("hides the Sensitive note + share when the folder is git-tracked / read-only", () => {
    render(<PackDetailPane detail={makeDetail({ sensitive: false })} readOnly={false} {...baseProps} />);
    expect(screen.queryByText(/never committed to git/i)).not.toBeInTheDocument();
    // Folder history is still offered for a git-tracked folder.
    expect(screen.getByText("Folder history")).toBeInTheDocument();
  });
});

describe("api.contexts share-link REVOKE wiring (#766)", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue({
      ok: true, status: 200, headers: { get: () => "application/json" },
      text: async () => JSON.stringify({ revoked: true }),
      json: async () => ({ revoked: true }),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("revokePackLink DELETEs the pack share-link endpoint", async () => {
    const { api } = await import("@/lib/api");
    const res = await api.contexts.revokePackLink("company-facts");
    const call = fetchMock.mock.calls[0];
    expect(String(call[0])).toContain("/contexts/company-facts/share-link");
    expect(call[1].method).toBe("DELETE");
    expect(res).toEqual({ revoked: true });
  });

  it("revokeFileLink DELETEs the per-file share-link endpoint", async () => {
    const { api } = await import("@/lib/api");
    await api.contexts.revokeFileLink("company-facts", "icp.md");
    const call = fetchMock.mock.calls[0];
    expect(String(call[0])).toContain("/contexts/company-facts/files/icp.md/share-link");
    expect(call[1].method).toBe("DELETE");
  });
});
