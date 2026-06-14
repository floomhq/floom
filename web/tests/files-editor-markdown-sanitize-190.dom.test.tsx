import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FilesEditor } from "@/components/worker-form/FilesEditor";

function href(scheme: string, body: string): string {
  return `${scheme}:${body}`;
}

function anchors(container: HTMLElement): HTMLAnchorElement[] {
  return Array.from(container.querySelectorAll("a"));
}

describe("#190 FilesEditor markdown link sanitization", () => {
  it("renders dangerous markdown links inert in preview mode", () => {
    const content = [
      `[js](${href("java" + "script", "alert(1)")})`,
      `[vb](${href("vb" + "script", "msgbox(1)")})`,
      `[inline](${href("da" + "ta", "text/plain,blocked")})`,
    ].join(" ");

    const { container } = render(
      <FilesEditor
        mode="view"
        selectedPath="README.md"
        files={[{ path: "README.md", content, language: "markdown" }]}
      />,
    );

    expect(anchors(container)).toHaveLength(3);
    for (const anchor of anchors(container)) {
      expect(anchor.getAttribute("href")).toBeNull();
    }
  });

  it("keeps safe markdown links working in preview mode", () => {
    const { container } = render(
      <FilesEditor
        mode="view"
        selectedPath="README.md"
        files={[
          {
            path: "README.md",
            content: "[site](https://example.com) [rel](/workers/abc)",
            language: "markdown",
          },
        ]}
      />,
    );

    const hrefs = anchors(container).map((anchor) => anchor.getAttribute("href"));
    expect(hrefs).toContain("https://example.com");
    expect(hrefs).toContain("/workers/abc");
  });
});
