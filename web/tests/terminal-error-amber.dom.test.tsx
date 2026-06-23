import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Terminal } from "@/components/ai-elements/terminal";

// #1785 — Failed run status / error treatment must be amber, never red.
// Floom DS: "red is NOT a Floom color." Error-level log lines in the Logs tab
// were hardcoded to text-red-700 / dark:text-[#ffb4a8] (red + salmon-pink),
// which the live audit flagged. They must use the amber `text-error` token
// (--color-error -> --negative -> --warning #C98A1A).
describe("Terminal error log lines", () => {
  it("colors error-level lines with the amber error token, not red", () => {
    const { container } = render(
      <Terminal
        lines={[
          { level: "info", message: "starting", timestamp: "" },
          { level: "error", message: "boom", timestamp: "" },
        ]}
      />,
    );

    const errorLine = Array.from(container.querySelectorAll("pre > div")).find(
      (el) => el.textContent?.includes("boom"),
    );
    expect(errorLine).toBeTruthy();
    expect(errorLine!.className).toContain("text-error");
    expect(errorLine!.className).not.toMatch(/text-red/);
    expect(errorLine!.className).not.toMatch(/#ffb4a8/);
  });
});
