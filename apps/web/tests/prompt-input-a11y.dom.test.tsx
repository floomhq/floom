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

function renderComposer(variant: "default" | "landing" = "default") {
  return render(
    <PromptInput
      value=""
      onChange={() => {}}
      onSubmit={() => {}}
      onFilesChange={() => {}}
      attachedFiles={[]}
      variant={variant}
    />,
  );
}

describe("PromptInput a11y (#1711)", () => {
  it("textarea has an accessible label", () => {
    renderComposer();
    expect(screen.getByRole("textbox", { name: "Message Emily" })).toBeTruthy();
  });

  it("textarea renders a visible focus ring (focus-visible:ring)", () => {
    renderComposer();
    const textarea = screen.getByRole("textbox", { name: "Message Emily" });
    expect(textarea.className).toMatch(/focus-visible:ring-2/);
    expect(textarea.className).toMatch(/focus-visible:ring-\[var\(--accent\)\]/);
  });
});

describe("PromptInput send-button label/aria (#1709)", () => {
  it("landing send button visible text is 'Hire' and accessible name is 'Hire worker'", () => {
    renderComposer("landing");
    const btn = screen.getByRole("button", { name: "Hire worker" });
    expect(btn.textContent).toContain("Hire");
  });

  it("default send button keeps the 'Send message' accessible name", () => {
    renderComposer("default");
    expect(screen.getByRole("button", { name: "Send message" })).toBeTruthy();
  });
});
