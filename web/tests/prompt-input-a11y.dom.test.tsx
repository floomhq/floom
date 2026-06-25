// #1711 / #1709 — Emily composer accessibility.
//   #1711: the composer <textarea> must (a) expose an accessible name and
//          (b) render a visible focus ring (focus-visible utility, not the
//          old bare `outline-none`).
//   #1709: the landing send button's visible label is "Hire"; its accessible
//          name is the full canonical action "Hire worker" — visible text and
//          accessible name must not diverge (the accessible name is a superset).
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/lib/api", () => ({
  api: { chat: { uploadAttachments: vi.fn().mockResolvedValue([]) } },
}));

import { PromptInput } from "@/components/emily/PromptInput";

function renderComposer({
  variant = "default",
  sendMode,
}: {
  variant?: "default" | "landing";
  sendMode?: "send" | "hire";
} = {}) {
  return render(
    <PromptInput
      value=""
      onChange={() => {}}
      onSubmit={() => {}}
      onFilesChange={() => {}}
      attachedFiles={[]}
      variant={variant}
      sendMode={sendMode}
    />,
  );
}

describe("PromptInput a11y (#1711)", () => {
  it("textarea has an accessible label", () => {
    renderComposer();
    expect(screen.getByRole("textbox", { name: /describe the job/i })).toBeTruthy();
  });

  it("composer wrapper renders a visible focus ring (focus-within:ring)", () => {
    renderComposer();
    const textarea = screen.getByRole("textbox", { name: /describe the job/i });
    const wrapper = textarea.parentElement?.parentElement as HTMLElement;
    expect(wrapper.className).toMatch(/focus-within:ring-2/);
    expect(wrapper.className).toMatch(/focus-within:ring-\[var\(--ring\)\]/);
  });
});

describe("PromptInput send-button label/aria (#1709)", () => {
  it("landing send button visible text is 'Hire' and accessible name is 'Hire worker'", () => {
    renderComposer({ variant: "landing" });
    const btn = screen.getByRole("button", { name: "Hire worker" });
    expect(btn.textContent).toContain("Hire");
  });

  it("default send button keeps the 'Send message' accessible name", () => {
    renderComposer();
    expect(screen.getByRole("button", { name: "Send message" })).toBeTruthy();
  });

  it("hire send mode can render on the grey default composer", () => {
    renderComposer({ sendMode: "hire" });
    const btn = screen.getByRole("button", { name: "Hire worker" });
    const textarea = screen.getByRole("textbox", { name: /describe the job/i });
    const wrapper = textarea.parentElement?.parentElement as HTMLElement;
    expect(btn.textContent).toContain("Hire");
    expect(wrapper.className).toContain("bg-[var(--bg-2)]");
    expect(wrapper.className).toContain("focus-within:bg-[var(--bg-3)]");
  });
});
