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

    await user.selectOptions(screen.getByLabelText("Attach folder"), "pricing");
    await user.click(screen.getByRole("button", { name: /Attach/ }));
    expect(onChange).toHaveBeenLastCalledWith(["company-facts", "pricing"]);
  });

  it("read-only mode hides editing controls", () => {
    render(<WorkerBrainEditor contexts={["a"]} availablePacks={[]} editable={false} onChange={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Read & write" })).not.toBeInTheDocument();
    expect(screen.getByText("Read only")).toBeInTheDocument();
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
