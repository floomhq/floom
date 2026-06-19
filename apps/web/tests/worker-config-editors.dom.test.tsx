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
