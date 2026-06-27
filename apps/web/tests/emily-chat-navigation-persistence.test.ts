import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

function read(relPath: string): string {
  return fs.readFileSync(path.resolve(__dirname, "..", relPath), "utf8");
}

describe("Emily chat persists across navigation (#2011)", () => {
  it("/chat uses the persistent Emily dock instead of a disposable full-page stream", () => {
    const appShell = read("components/layout/AppShell.tsx");
    const chatPage = read("app/chat/page.tsx");

    expect(appShell).not.toMatch(/noDockPrefixes\s*=\s*\[[^\]]*["']\/chat["']/);
    expect(chatPage).toContain("EmilyChatRouteFullscreen");
    expect(chatPage).not.toContain("EmilyChatPage");
  });

  it("route-change cleanup does not clear the active Emily conversation", () => {
    const emilyChat = read("components/emily/EmilyChat.tsx");
    const cleanupStart = emilyChat.indexOf("#2011: route navigation must never clear");
    expect(cleanupStart).toBeGreaterThan(-1);
    const cleanupBlock = emilyChat.slice(cleanupStart, cleanupStart + 900);

    expect(cleanupBlock).not.toMatch(/(?:^|[^\w])newSession\(\);/);
    expect(cleanupBlock).not.toContain("coreActionsRef.current?.newSession");
  });
});
