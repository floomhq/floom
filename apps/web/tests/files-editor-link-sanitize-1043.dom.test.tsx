// #1043 — XSS via unsanitized javascript: links in worker file markdown preview.
// FilesEditor's RenderedFilePreview renders untrusted worker file markdown; anchor
// hrefs must never pass through dangerous protocols (javascript:, data:, vbscript:).
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { FilesEditor } from "@/components/worker-form/FilesEditor";
import type { WorkerFile } from "@/lib/types";

function anchors(container: HTMLElement): HTMLAnchorElement[] {
  return Array.from(container.querySelectorAll("a"));
}

function mdFile(content: string): WorkerFile {
  return {
    path: "test.md",
    language: "markdown",
    content,
    binary: false,
    size: content.length,
  };
}

describe("#1043 FilesEditor markdown link sanitization", () => {
  const payloads = [
    "[click me](javascript:alert(document.cookie))",
    "[click me](JaVaScRiPt:alert(1))",
    "[click me](vbscript:msgbox(1))",
    "[click me](data:text/html,<script>alert(1)</script>)",
  ];

  for (const md of payloads) {
    it(`never renders a dangerous href for ${md.slice(11, 30)}…`, () => {
      const { container } = render(
        <FilesEditor mode="view" files={[mdFile(md)]} selectedPath="test.md" />,
      );
      const found = anchors(container);
      expect(found.length).toBeGreaterThan(0); // link text must still render
      for (const a of found) {
        const href = a.getAttribute("href") ?? "";
        expect(href).not.toMatch(/^\s*(javascript|vbscript|data):/i);
      }
    });
  }

  it("keeps safe links working (https, mailto, relative)", () => {
    const md = "[site](https://example.com) [mail](mailto:a@b.co) [rel](/workers/abc)";
    const { container } = render(
      <FilesEditor mode="view" files={[mdFile(md)]} selectedPath="test.md" />,
    );
    const hrefs = anchors(container).map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("https://example.com");
    expect(hrefs).toContain("mailto:a@b.co");
    expect(hrefs).toContain("/workers/abc");
  });
});
