import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkerToolsEditor } from "@/components/worker/WorkerToolsEditor";
import type { WorkerConnectionSpec } from "@/lib/types";

// Radix/base-ui pointer shims for jsdom.
if (!(Element.prototype as { hasPointerCapture?: unknown }).hasPointerCapture) {
  (Element.prototype as unknown as { hasPointerCapture: () => boolean }).hasPointerCapture = () => false;
  (Element.prototype as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {};
  (Element.prototype as unknown as { releasePointerCapture: () => void }).releasePointerCapture = () => {};
  (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
}

// Round-09 B4 — Tools editor.
//  - Add tool is a SEARCHABLE combobox over EXISTING connections (type-to-filter
//    the ~1k, select from filtered), NOT a free-text slug input.
//  - Per-app allowlist is a MULTISELECT of that app's known tools, not a comma
//    string.
//  - No spurious "onChange" (-> "Tools updated" toast) on a no-op blur/click.

const availableApps = [
  { slug: "github", name: "GitHub" },
  { slug: "gmail", name: "Gmail" },
  { slug: "stripe", name: "Stripe" },
  { slug: "slack", name: "Slack" },
];

const toolsForApp = (slug: string): string[] => {
  const map: Record<string, string[]> = {
    gmail: ["SEND", "READ", "DRAFT"],
    github: ["CREATE_ISSUE", "LIST_REPOS"],
  };
  return map[slug] ?? [];
};

describe("B4 — Add tool is a searchable combobox over existing connections", () => {
  it("does NOT render a free-text slug input", () => {
    render(
      <WorkerToolsEditor
        connections={[]}
        editable
        onChange={vi.fn()}
        availableApps={availableApps}
        toolsForApp={toolsForApp}
      />,
    );
    // The old free-text "App slug" input is gone.
    expect(screen.queryByPlaceholderText(/app slug/i)).not.toBeInTheDocument();
  });

  it("type-to-filters the connection list and adds the picked app", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <WorkerToolsEditor
        connections={[]}
        editable
        onChange={onChange}
        availableApps={availableApps}
        toolsForApp={toolsForApp}
      />,
    );

    await user.click(screen.getByRole("button", { name: /add a tool/i }));
    const filter = screen.getByLabelText(/search tools/i);
    await user.type(filter, "git");

    // Only GitHub remains after filtering on "git".
    await waitFor(() => {
      expect(screen.getByRole("option", { name: /github/i })).toBeInTheDocument();
      expect(screen.queryByRole("option", { name: /^gmail$/i })).not.toBeInTheDocument();
    });

    await user.click(screen.getByRole("option", { name: /github/i }));
    await user.click(screen.getByRole("button", { name: /^Add tool$/i }));
    expect(onChange).toHaveBeenLastCalledWith([...[], "github"]);
  });

  it("excludes already-connected apps from the combobox", async () => {
    const user = userEvent.setup();
    render(
      <WorkerToolsEditor
        connections={[{ composio: { app: "gmail" } }]}
        editable
        onChange={vi.fn()}
        availableApps={availableApps}
        toolsForApp={toolsForApp}
      />,
    );
    await user.click(screen.getByRole("button", { name: /add a tool/i }));
    // gmail is already connected -> not offered again.
    expect(screen.queryByRole("option", { name: /^gmail$/i })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: /github/i })).toBeInTheDocument();
  });
});

describe("B4 — per-app allowlist is a multiselect of known tools", () => {
  const conns: WorkerConnectionSpec[] = [{ composio: { app: "gmail", allowed_tools: ["SEND"] } }];

  it("offers the app's known tools as toggleable options, not a comma string", async () => {
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
    // No comma-separated free-text allowlist input.
    expect(screen.queryByPlaceholderText(/comma-separated/i)).not.toBeInTheDocument();

    // Open the gmail allowlist editor.
    await user.click(screen.getByRole("button", { name: /restrict gmail tools/i }));

    // Toggle READ on (SEND already on), then commit with Done. Deferred commit
    // emits the union ONCE via setComposioAllowlist (no per-keystroke toast).
    await user.click(screen.getByRole("option", { name: /READ/ }));
    await user.click(screen.getByRole("button", { name: /^Done$/ }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith([
      { composio: { app: "gmail", allowed_tools: ["SEND", "READ"] } },
    ]);
  });

  it("the allowlist field is LABELED (B4: 'Stripe field unclear')", () => {
    render(
      <WorkerToolsEditor
        connections={conns}
        editable
        onChange={vi.fn()}
        availableApps={availableApps}
        toolsForApp={toolsForApp}
      />,
    );
    expect(screen.getByRole("button", { name: /restrict gmail tools/i })).toBeInTheDocument();
  });
});

describe("B4 — no spurious onChange (kills the phantom 'Tools updated' toast)", () => {
  const conns: WorkerConnectionSpec[] = [{ composio: { app: "gmail", allowed_tools: ["SEND"] } }];

  it("opening and closing the allowlist with no change emits NO onChange", async () => {
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
    // Open then close the allowlist editor without touching any tool.
    await user.click(screen.getByRole("button", { name: /restrict gmail tools/i }));
    await user.click(screen.getByRole("button", { name: /restrict gmail tools/i }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("toggling a tool ON then OFF back to the original set emits NO net change at close", async () => {
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
    onChange.mockClear();
    // READ on, then READ off -> back to {SEND}. No onChange should fire because
    // the value is identical to where it started.
    await user.click(screen.getByRole("option", { name: /READ/ }));
    await user.click(screen.getByRole("option", { name: /READ/ }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
