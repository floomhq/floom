// #914 — XSS via unsanitized javascript: links in rendered markdown.
// Worker output and Emily chat render untrusted markdown; anchor hrefs must
// never pass through dangerous protocols (javascript:, data:, vbscript:).
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { GenericOutput } from "@/components/generic-output";
import { MarkdownText } from "@/components/emily/MarkdownText";
import { sanitizeHref } from "@/lib/safe-url";

function anchors(container: HTMLElement): HTMLAnchorElement[] {
  return Array.from(container.querySelectorAll("a"));
}

describe("#914 markdown link sanitization", () => {
  const payloads = [
    "[click me](javascript:alert(document.cookie))",
    "[click me](JaVaScRiPt:alert(1))",
    "[click me](vbscript:msgbox(1))",
    "[click me](data:text/html,<script>alert(1)</script>)",
  ];

  for (const md of payloads) {
    it(`GenericOutput never renders a dangerous href for ${md.slice(11, 30)}…`, () => {
      const { container } = render(<GenericOutput type="markdown" value={md} />);
      const found = anchors(container);
      expect(found.length).toBeGreaterThan(0); // link text must still render
      for (const a of found) {
        const href = a.getAttribute("href") ?? "";
        expect(href).not.toMatch(/^\s*(javascript|vbscript|data):/i);
      }
    });

    it(`MarkdownText never renders a dangerous href for ${md.slice(11, 30)}…`, () => {
      const { container } = render(<MarkdownText text={md} />);
      expect(anchors(container).length).toBeGreaterThan(0);
      for (const a of anchors(container)) {
        const href = a.getAttribute("href") ?? "";
        expect(href).not.toMatch(/^\s*(javascript|vbscript|data):/i);
      }
    });
  }

  it("keeps safe links working (https, mailto, relative)", () => {
    const md =
      "[site](https://example.com) [mail](mailto:a@b.co) [rel](/runs/123)";
    const { container } = render(<GenericOutput type="markdown" value={md} />);
    const hrefs = anchors(container).map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("https://example.com");
    expect(hrefs).toContain("mailto:a@b.co");
    expect(hrefs).toContain("/runs/123");
  });

  it("does not render protocol-relative links as same-tab internal links", () => {
    const md = "[View failed run](//attacker.example/fake-login)";

    for (const container of [
      render(<GenericOutput type="markdown" value={md} />).container,
      render(<MarkdownText text={md} />).container,
    ]) {
      const found = anchors(container);
      expect(found.length).toBe(1);
      expect(found[0].getAttribute("href")).toBeNull();
      expect(found[0].getAttribute("target")).toBe("_blank");
    }
  });
});

describe("#914 sanitizeHref unit", () => {
  it("blocks dangerous protocols", () => {
    expect(sanitizeHref("javascript:alert(1)")).toBeUndefined();
    expect(sanitizeHref("JAVASCRIPT:alert(1)")).toBeUndefined();
    expect(sanitizeHref(" \tjavascript:alert(1)")).toBeUndefined();
    expect(sanitizeHref("java\nscript:alert(1)")).toBeUndefined();
    expect(sanitizeHref("java\r\n\t\x7Fscript:alert(1)")).toBeUndefined();
    expect(sanitizeHref("vbscript:x")).toBeUndefined();
    expect(sanitizeHref("data:text/html,x")).toBeUndefined();
    expect(sanitizeHref("file:///etc/passwd")).toBeUndefined();
  });

  it("blocks protocol-relative external URLs", () => {
    expect(sanitizeHref("//attacker.example/fake-login")).toBeUndefined();
    expect(sanitizeHref(" \t//attacker.example/fake-login")).toBeUndefined();
  });

  it("allows http(s), mailto, tel and relative URLs", () => {
    expect(sanitizeHref("https://example.com/a?b=c")).toBe(
      "https://example.com/a?b=c",
    );
    expect(sanitizeHref("http://example.com")).toBe("http://example.com");
    expect(sanitizeHref("mailto:a@b.co")).toBe("mailto:a@b.co");
    expect(sanitizeHref("tel:+15551234567")).toBe("tel:+15551234567");
    expect(sanitizeHref("/workers/abc")).toBe("/workers/abc");
    expect(sanitizeHref("../up")).toBe("../up");
    expect(sanitizeHref("#anchor")).toBe("#anchor");
    expect(sanitizeHref("?q=1")).toBe("?q=1");
  });

  it("handles empty/undefined", () => {
    expect(sanitizeHref(undefined)).toBeUndefined();
    expect(sanitizeHref("")).toBeUndefined();
  });
});
