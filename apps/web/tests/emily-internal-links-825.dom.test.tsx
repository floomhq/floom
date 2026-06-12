// #825/#903 requirement 3 — Emily's answers reference app pages as REAL
// router links (client navigation, same tab); external links open in a new
// tab. Requirements 1/2/4 (collapsible ai-elements/tool.tsx, inline approval
// cards, one component set for chat + run details) are covered by
// emily-tool-card-renderer.dom.test.tsx and approval-card.dom.test.tsx.
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { MarkdownText } from "@/components/emily/MarkdownText";

function anchorFor(container: HTMLElement, text: string): HTMLAnchorElement {
  const a = Array.from(container.querySelectorAll("a")).find(
    (el) => el.textContent === text,
  );
  if (!a) throw new Error(`no anchor with text ${text}`);
  return a;
}

describe("#825/#903 Emily page links", () => {
  it("renders internal app paths as same-tab router links", () => {
    const { container } = render(
      <MarkdownText text="See [the run](/runs/run_42) and [the worker](/workers/w1?tab=about)." />,
    );
    for (const label of ["the run", "the worker"]) {
      const a = anchorFor(container, label);
      expect(a.getAttribute("target")).toBeNull();
      expect(a.getAttribute("href")).toMatch(/^\/(runs|workers)\//);
    }
  });

  it("keeps external links in a new tab with noopener", () => {
    const { container } = render(
      <MarkdownText text="Docs at [example](https://example.com/docs)." />,
    );
    const a = anchorFor(container, "example");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toContain("noopener");
  });

  it("never emits dangerous hrefs even via the internal-link path", () => {
    const { container } = render(
      <MarkdownText text="[x](javascript:alert(1)) [y](/safe)" />,
    );
    for (const a of Array.from(container.querySelectorAll("a"))) {
      expect(a.getAttribute("href") ?? "").not.toMatch(/^javascript:/i);
    }
  });
});
