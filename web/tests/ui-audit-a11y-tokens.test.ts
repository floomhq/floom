import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const src = (path: string) => readFileSync(join(root, path), "utf8");

describe("UI audit a11y and token regressions", () => {
  it("base buttons expose visible focus rings and larger hit areas", () => {
    const button = src("components/ui/button.tsx");
    expect(button).toContain("focus-visible:ring-2");
    expect(button).toContain("focus-visible:ring-[var(--accent)]");
    expect(button).toContain("focus-visible:ring-offset-[var(--bg-app)]");
    expect(button).toContain('icon: "size-11"');
    expect(button).toContain('"icon-sm":');
    expect(button).toContain('"size-10');
    expect(button).not.toContain('xs: "h-6');
    expect(button).not.toContain('sm: "h-7');
    expect(button).not.toContain('"icon-sm":\n          "size-7');
  });

  it("IconButton defaults to the 44px icon hit area", () => {
    const iconButton = src("components/ui/icon-button.tsx");
    expect(iconButton).toContain('size = "icon"');
    expect(iconButton).toContain("44px hit-area");
  });

  it("brain file icons use semantic tokens, not hardcoded hex colors", () => {
    const fileIcon = src("lib/brain/file-type-icon.ts");
    expect(fileIcon).not.toMatch(/#[0-9A-Fa-f]{3,8}/);
    expect(fileIcon).toContain('tint: "var(--warning)"');
    expect(fileIcon).toContain('tint: "var(--accent)"');
    expect(fileIcon).toContain('tint: "var(--positive)"');
  });

  it("terminal uses tokens for dark mode and error output", () => {
    const terminal = src("components/ai-elements/terminal.tsx");
    expect(terminal).not.toMatch(/#[0-9A-Fa-f]{3,8}/);
    expect(terminal).not.toMatch(/text-red|text-error/);
    expect(terminal).toContain("dark:bg-[var(--bg-2)]");
    expect(terminal).toContain("text-[var(--warning)]");
  });
});
