import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkerBrainEditor } from "@/components/worker/WorkerBrainEditor";
import { WorkerToolsEditor } from "@/components/worker/WorkerToolsEditor";
import type { WorkerConnectionSpec } from "@/lib/types";

describe("WorkerBrainEditor", () => {
  it("toggles read/write, removes, and attaches (emitting next contexts)", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <WorkerBrainEditor
        contexts={["company-facts"]}
        availablePacks={[{ name: "company-facts" }, { name: "pricing" }]}
        editable
        onChange={onChange}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Read & write" }));
    expect(onChange).toHaveBeenLastCalledWith([{ name: "company-facts", writeable: true }]);

    await user.click(screen.getByRole("button", { name: "Remove company-facts" }));
    expect(onChange).toHaveBeenLastCalledWith([]);

    await user.click(screen.getByRole("button", { name: /Attach a folder/ }));
    await user.click(screen.getByRole("option", { name: "pricing" }));
    await user.click(screen.getByRole("button", { name: /Attach/ }));
    expect(onChange).toHaveBeenLastCalledWith(["company-facts", "pricing"]);
  });

  it("read-only mode hides editing controls", () => {
    render(<WorkerBrainEditor contexts={["a"]} availablePacks={[]} editable={false} onChange={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Read & write" })).not.toBeInTheDocument();
    expect(screen.getByText("Read only")).toBeInTheDocument();
  });

  it("offers a Connect memory folder CTA when the worker's memory folder is not attached", async () => {
    const user = userEvent.setup();
    const onAttachMemory = vi.fn();
    render(
      <WorkerBrainEditor
        contexts={[]}
        availablePacks={[]}
        editable
        onChange={vi.fn()}
        memoryFolderName="my-worker-memory"
        onAttachMemory={onAttachMemory}
      />,
    );
    const cta = screen.getByRole("button", { name: /Connect a memory folder/i });
    expect(cta).toBeInTheDocument();
    expect(screen.getByText("my-worker-memory")).toBeInTheDocument();
    await user.click(cta);
    expect(onAttachMemory).toHaveBeenCalledTimes(1);
  });

  it("hides the memory CTA once the memory folder is already attached", () => {
    render(
      <WorkerBrainEditor
        contexts={["my-worker-memory"]}
        availablePacks={[{ name: "my-worker-memory" }]}
        editable
        onChange={vi.fn()}
        memoryFolderName="my-worker-memory"
        onAttachMemory={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /Connect a memory folder/i })).not.toBeInTheDocument();
  });

  it("locks the worker's own memory folder to Read & write (no silent-revert toggle/detach)", () => {
    // The engine force-pins the worker's memory context writeable and re-mounts
    // it on every save, so an interactive toggle/detach here would silently
    // revert while still firing a success toast. The row must be locked instead.
    render(
      <WorkerBrainEditor
        contexts={[{ name: "memory-morning-brief", writeable: true }, "company-facts"]}
        availablePacks={[{ name: "memory-morning-brief" }, { name: "company-facts" }]}
        editable
        onChange={vi.fn()}
        memoryFolderName="memory-morning-brief"
        memoryPinned
      />,
    );
    // No Read toggle and no detach for the pinned memory row...
    expect(screen.queryByRole("group", { name: "memory-morning-brief access" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove memory-morning-brief" })).not.toBeInTheDocument();
    // ...but a locked Read & write indicator is shown.
    expect(screen.getByTitle(/always read & write/i)).toBeInTheDocument();
    // A normal (non-memory) folder keeps its interactive controls.
    expect(screen.getByRole("group", { name: "company-facts access" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove company-facts" })).toBeInTheDocument();
  });

  it("does not lock the memory folder when memory is disabled (memoryPinned false)", () => {
    render(
      <WorkerBrainEditor
        contexts={[{ name: "memory-morning-brief", writeable: true }]}
        availablePacks={[{ name: "memory-morning-brief" }]}
        editable
        onChange={vi.fn()}
        memoryFolderName="memory-morning-brief"
        memoryPinned={false}
      />,
    );
    expect(screen.getByRole("group", { name: "memory-morning-brief access" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove memory-morning-brief" })).toBeInTheDocument();
  });

  it("groups packs sharing a name prefix into a collapsible tree node in the attach picker", async () => {
    // brain_packs has no parent/path column — packs sharing a "<prefix>-*"
    // lead segment (e.g. two workers' own "memory-<id>" folders) should
    // collapse into one expandable group instead of listing every folder
    // flat (#attach-folder-tree).
    const user = userEvent.setup();
    render(
      <WorkerBrainEditor
        contexts={[]}
        availablePacks={[
          { name: "memory-morning-brief" },
          { name: "memory-inbox-cleaner" },
          { name: "company-facts" },
        ]}
        editable
        onChange={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Attach a folder/ }));

    // The two "memory-*" packs collapse into one group row; the lone
    // "company-facts" pack (no shared prefix) still renders as a flat option.
    expect(screen.getByRole("option", { name: "company-facts" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "memory-morning-brief" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "memory-inbox-cleaner" })).not.toBeInTheDocument();
    const groupToggle = screen.getByRole("button", { name: /memory/i });
    expect(groupToggle).toBeInTheDocument();

    await user.click(groupToggle);
    expect(screen.getByRole("option", { name: "memory-morning-brief" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "memory-inbox-cleaner" })).toBeInTheDocument();
  });

  it("hides the memory CTA in read-only mode", () => {
    render(
      <WorkerBrainEditor
        contexts={[]}
        availablePacks={[]}
        editable={false}
        onChange={vi.fn()}
        memoryFolderName="my-worker-memory"
        onAttachMemory={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /Connect a memory folder/i })).not.toBeInTheDocument();
  });
});

describe("WorkerToolsEditor", () => {
  // Round-09 B4: the editor now takes availableApps (combobox source) and
  // toolsForApp (allowlist multiselect source). Add/allowlist/no-spurious-toast
  // behavior is covered in worker-tools-editor-b4.dom.test.tsx; this block keeps
  // the remove + manifest-invariant coverage on the new API.
  const conns: WorkerConnectionSpec[] = [{ composio: { app: "gmail", allowed_tools: ["SEND"] } }];
  const availableApps = [
    { slug: "github", name: "GitHub" },
    { slug: "gmail", name: "Gmail" },
  ];
  const toolsForApp = (slug: string) => (slug === "gmail" ? ["SEND", "READ", "DRAFT"] : []);

  it("removes a connection (emitting next connections)", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <WorkerToolsEditor
        connections={conns}
        editable
        onChange={onChange}
        availableApps={availableApps}
        toolsForApp={toolsForApp}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Remove gmail" }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("clearing the whole allowlist drops the key (full access, never [])", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <WorkerToolsEditor
        connections={conns}
        editable
        onChange={onChange}
        availableApps={availableApps}
        toolsForApp={toolsForApp}
      />,
    );
    await user.click(screen.getByRole("button", { name: /restrict gmail tools/i }));
    // Deselect the only allowed tool (SEND), then commit -> empty set drops the
    // allowed_tools key entirely (full access), never an empty [].
    await user.click(screen.getByRole("option", { name: /SEND/ }));
    await user.click(screen.getByRole("button", { name: /^Done$/ }));
    expect(onChange).toHaveBeenLastCalledWith([{ composio: { app: "gmail" } }]);
  });
});
