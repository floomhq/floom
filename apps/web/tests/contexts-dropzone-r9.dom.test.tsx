import { describe, it, expect } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  PackDetailPane,
  ContextEmptyState,
  MemoryPackGroup,
  isWorkerMemoryContext,
  isWorkerMemoryPack,
  memoryGroupOpenForView,
} from "@/app/contexts/page";
import type { ContextDetail, ContextSummary } from "@/lib/types";

// Round-09 B11 + B6 — drag-upload affordance.
// B11: dragging must NOT wash the whole right pane grey (bg-muted/30). The
//      affordance is ONE clearly-bounded dashed rounded drop-zone box.
// B6:  the Library empty state must SHOW a dashed drop-zone box (the missing
//      drop affordance), persistent even when not dragging.

function makeDetail(overrides: Partial<ContextDetail> = {}): ContextDetail {
  return {
    name: "company-facts",
    file_count: 1,
    total_size_bytes: 1200,
    writeable: true,
    worker_count: 0,
    read_only: false,
    sensitive: false,
    visibility: "private",
    owner_id: "u1",
    files: [
      { path: "icp.md", size: 1200, mime_type: "text/markdown", updated_at: "2026-06-17T00:00:00Z", is_binary: false },
    ],
    used_by: [],
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

describe("B11 — no whole-pane grey wash on drag", () => {
  it("the detail pane never carries bg-muted/30, dragging or not", () => {
    const { container, rerender } = render(
      <PackDetailPane detail={makeDetail()} readOnly={false} {...baseProps} dragActive={false} />,
    );
    const section = container.querySelector("section");
    expect(section).not.toBeNull();
    expect(section!.className).not.toMatch(/bg-muted\/30/);

    rerender(
      <PackDetailPane detail={makeDetail()} readOnly={false} {...baseProps} dragActive={true} />,
    );
    const sectionDragging = container.querySelector("section");
    expect(sectionDragging!.className).not.toMatch(/bg-muted\/30/);
  });

  it("renders a single DASHED bounded drop-zone box while dragging", () => {
    const { container } = render(
      <PackDetailPane detail={makeDetail()} readOnly={false} {...baseProps} dragActive={true} />,
    );
    // The drop affordance is a dashed-bordered box, not a solid-border filled card.
    const dashed = container.querySelectorAll('[data-dropzone="true"]');
    expect(dashed.length).toBe(1);
    expect(dashed[0].className).toMatch(/border-dashed/);
  });

  it("shows no drop-zone box when not dragging (overlay only appears on drag)", () => {
    const { container } = render(
      <PackDetailPane detail={makeDetail()} readOnly={false} {...baseProps} dragActive={false} />,
    );
    expect(container.querySelectorAll('[data-dropzone="true"]').length).toBe(0);
  });

  it("read-only folders never show a drop affordance", () => {
    const { container } = render(
      <PackDetailPane detail={makeDetail({ read_only: true })} readOnly={true} {...baseProps} dragActive={true} />,
    );
    expect(container.querySelectorAll('[data-dropzone="true"]').length).toBe(0);
  });
});

describe("B6 — Library empty state has a dashed drop-zone affordance", () => {
  it("renders a persistent dashed drop-zone box even when not dragging", () => {
    const { container } = render(
      <ContextEmptyState dragActive={false} onNewFolder={() => {}} dropHandlers={{}} />,
    );
    const zone = container.querySelector('[data-dropzone="true"]');
    expect(zone).not.toBeNull();
    expect(zone!.className).toMatch(/border-dashed/);
  });

  it("does NOT wash the whole empty-state pane grey on drag", () => {
    const { container } = render(
      <ContextEmptyState dragActive={true} onNewFolder={() => {}} dropHandlers={{}} />,
    );
    const section = container.querySelector("section");
    expect(section!.className).not.toMatch(/bg-muted\/30/);
    // The dashed box is still the single affordance, now in its active state.
    expect(container.querySelectorAll('[data-dropzone="true"]').length).toBe(1);
  });
});

describe("Memory folder grouping", () => {
  const memoryPacks: ContextSummary[] = [
    { name: "memory-morning-brief", file_count: 2, total_size_bytes: 20, worker_count: 1, read_only: false, writeable: true, visibility: "private" },
    { name: "memory-worker-author", file_count: 1, total_size_bytes: 10, worker_count: 1, read_only: false, writeable: true, visibility: "private" },
  ];

  it("classifies only worker memory folders", () => {
    expect(isWorkerMemoryContext("memory-morning-brief")).toBe(true);
    expect(isWorkerMemoryContext("memory-sales.v2")).toBe(true);
    expect(isWorkerMemoryContext("company-memory")).toBe(false);
    expect(isWorkerMemoryContext("memory")).toBe(false);
    expect(isWorkerMemoryPack({ name: "team-notes", category: "memory", worker_count: 1 })).toBe(true);
    expect(isWorkerMemoryPack({ name: "memory", category: "memory", worker_count: 1 })).toBe(false);
    expect(isWorkerMemoryPack({ name: "team-notes", category: "memory", worker_count: 0 })).toBe(false);
  });

  it("keeps matching memory folders visible during search", () => {
    expect(memoryGroupOpenForView(false, false, "worker-author")).toBe(true);
    expect(memoryGroupOpenForView(false, false, "")).toBe(false);
  });

  it("clusters memory folders behind one parent row", () => {
    render(
      <MemoryPackGroup
        packs={memoryPacks}
        selectedName=""
        compact={false}
        open={false}
        onToggle={() => {}}
        onSelect={() => {}}
        onDelete={() => {}}
      />,
    );

    expect(screen.getByRole("button", { name: /memory/i })).toBeInTheDocument();
    expect(screen.queryByText("memory-morning-brief")).toBeNull();
  });

  it("reveals memory folder children when expanded", () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <MemoryPackGroup
          packs={memoryPacks}
          selectedName=""
          compact={false}
          open={open}
          onToggle={() => setOpen((value) => !value)}
          onSelect={() => {}}
          onDelete={() => {}}
        />
      );
    }

    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /memory/i }));

    expect(screen.getByText("memory-morning-brief")).toBeInTheDocument();
    expect(screen.getByText("memory-worker-author")).toBeInTheDocument();
  });
});
