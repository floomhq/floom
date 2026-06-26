import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const viewSource = readFileSync(
  join(process.cwd(), "components", "collection", "CollectionView.tsx"),
  "utf8",
);
const cssSource = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8");

describe("collection toolbar layout", () => {
  it("keeps the search row separated from the divider", () => {
    expect(viewSource).toMatch(
      /className="c-controlstrip" style=\{\{ padding: `8px \$\{PAGE_X\}px 10px` \}\}/,
    );
  });

  it("keeps the resting search input at a compact desktop width", () => {
    expect(cssSource).toContain("flex: 0 1 420px;");
    expect(cssSource).toContain("max-width: 420px;");
    expect(cssSource).not.toContain("max-width: 560px;");
  });
});
