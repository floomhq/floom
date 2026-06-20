// a11y #1711: the Emily composer textarea must have an accessible name
// (aria-label) and the composer must show a visible focus indicator (the inner
// textarea is outline-none, so the focus ring lives on the wrapper).
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { PromptInput } from "@/components/emily/PromptInput";

vi.mock("@/lib/api", async (importOriginal) => {
  const mod = await importOriginal<Record<string, unknown>>();
  return {
    ...mod,
    api: {
      ...(mod.api as Record<string, unknown>),
      chat: { uploadAttachments: vi.fn().mockResolvedValue([]) },
    },
  };
});

function renderComposer() {
  return render(
    <PromptInput
      value=""
      onChange={() => {}}
      onSubmit={() => {}}
      onFilesChange={() => {}}
      attachedFiles={[]}
      placeholder="Describe the job you want done…"
    />,
  );
}

describe("PromptInput a11y (#1711)", () => {
  it("gives the textarea an accessible name", () => {
    renderComposer();
    expect(
      screen.getByRole("textbox", { name: /describe the job/i }),
    ).toBeInTheDocument();
  });

  it("renders a visible focus ring on the composer wrapper", () => {
    renderComposer();
    const textarea = screen.getByRole("textbox", { name: /describe the job/i });
    const wrapper = textarea.parentElement as HTMLElement;
    // Token-based focus-within ring (replaces the removed outline on the textarea).
    expect(wrapper.className).toMatch(/focus-within:ring-2/);
    expect(wrapper.className).toMatch(/focus-within:ring-\[var\(--ring\)\]/);
  });
});
