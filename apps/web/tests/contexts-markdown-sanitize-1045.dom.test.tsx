// #1045 — XSS via unsanitized javascript: links in the contexts MarkdownRenderer.
// Brain/context markdown is untrusted; anchor hrefs must never pass through
// dangerous protocols (javascript:, data:, vbscript:, file:).
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { MarkdownRenderer } from "@/components/contexts/markdown-renderer";

function anchors(container: HTMLElement): HTMLAnchorElement[] {
  return Array.from(container.querySelectorAll("a"));
}

describe("#1045 contexts MarkdownRenderer link sanitization", () => {
  const payloads = [
    "[click me](javascript:alert(document.cookie))",
    "[click me](JaVaScRiPt:alert(1))",
    "[click me](vbscript:msgbox(1))",
    "[click me](data:text/html,<script>alert(1)</script>)",
    "[click me](file:///etc/passwd)",
  ];

  for (const md of payloads) {
    it(`never renders a dangerous href for ${md.slice(11, 30)}…`, () => {
      const { container } = render(<MarkdownRenderer content={md} />);
      const found = anchors(container);
      expect(found.length).toBeGreaterThan(0); // link text must still render
      for (const a of found) {
        const href = a.getAttribute("href") ?? "";
        expect(href).not.toMatch(/^\s*(javascript|vbscript|data|file):/i);
      }
    });
  }

  it("keeps safe links working (https, mailto, relative)", () => {
    const md = "[site](https://example.com) [mail](mailto:a@b.co) [rel](/brain/my-pack)";
    const { container } = render(<MarkdownRenderer content={md} />);
    const hrefs = anchors(container).map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("https://example.com");
    expect(hrefs).toContain("mailto:a@b.co");
    expect(hrefs).toContain("/brain/my-pack");
  });
});
