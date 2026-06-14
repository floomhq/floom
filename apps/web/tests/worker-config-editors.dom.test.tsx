import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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
  const conns: WorkerConnectionSpec[] = [{ composio: { app: "gmail", allowed_tools: ["SEND"] } }];

  it("adds a tool, removes one, and edits the allowlist", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<WorkerToolsEditor connections={conns} editable onChange={onChange} />);

    await user.type(screen.getByLabelText("Add tool"), "github");
    await user.click(screen.getByRole("button", { name: /Add tool/ }));
    expect(onChange).toHaveBeenLastCalledWith([...conns, "github"]);

    // allowlist edit → blur emits setComposioAllowlist
    const allow = screen.getByLabelText("gmail allowed tools");
    fireEvent.change(allow, { target: { value: "SEND, READ" } });
    fireEvent.blur(allow);
    expect(onChange).toHaveBeenLastCalledWith([{ composio: { app: "gmail", allowed_tools: ["SEND", "READ"] } }]);

    await user.click(screen.getByRole("button", { name: "Remove gmail" }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("clearing the allowlist drops the key (full access, never [])", () => {
    const onChange = vi.fn();
    render(<WorkerToolsEditor connections={conns} editable onChange={onChange} />);
    const allow = screen.getByLabelText("gmail allowed tools");
    fireEvent.change(allow, { target: { value: "" } });
    fireEvent.blur(allow);
    expect(onChange).toHaveBeenLastCalledWith([{ composio: { app: "gmail" } }]);
  });
});
