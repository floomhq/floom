import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("workers new from-prompt route", () => {
  it("keeps the legacy prompt-to-worker URL mounted", () => {
    const routeFile = join(process.cwd(), "app/workers/new/from-prompt/page.tsx");

    expect(readFileSync(routeFile, "utf8").trim()).toBe('export { default } from "../page";');
  });
});
