import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..");

function readWeb(path: string) {
  return readFileSync(join(root, path), "utf8");
}

function readOverlay(path: string) {
  return readFileSync(join(root, "overlay", path), "utf8");
}

describe("Cloud overlay parity", () => {
  it("renders Emily on app pages while leaving full-page chat undocked", () => {
    const webChrome = readWeb("components/CloudAppChrome.tsx");
    const chrome = readOverlay("components/CloudAppChrome.tsx");

    expect(webChrome).toBe(chrome);
    expect(chrome).toContain('import { EmilyDock } from "@/components/emily/EmilyChat";');
    expect(chrome).toContain('const isChatPath =');
    expect(chrome).toContain('pathname === "/app/chat"');
    expect(chrome).toContain('if (isChatPath)');
    expect(chrome).toContain('<EmilyDock className="hidden md:flex" />');

    const chatBranchStart = chrome.indexOf("if (isChatPath)");
    const defaultBranchStart = chrome.indexOf("return (", chatBranchStart + 1);
    expect(chatBranchStart).toBeGreaterThanOrEqual(0);
    expect(defaultBranchStart).toBeGreaterThan(chatBranchStart);
    expect(chrome.slice(chatBranchStart, defaultBranchStart)).not.toContain("<EmilyDock");
  });

  it("uses outcome-first workspace action labels", () => {
    const webSwitcher = readWeb("components/layout/WorkspaceSwitcher.tsx");
    const switcher = readOverlay("components/layout/WorkspaceSwitcher.tsx");

    expect(webSwitcher).toBe(switcher);
    expect(switcher).not.toContain("Copy setup link");
    expect(switcher).toContain("Invite someone by link");
    expect(switcher).toContain("Invite link copied");
  });

  it("keeps the cloud /api/me route mirrored between web and overlay", () => {
    const webMeHelper = readWeb("app/lib/me.ts");
    const overlayMeHelper = readOverlay("app/lib/me.ts");
    const webMe = readWeb("app/api/me/route.ts");
    const overlayMe = readOverlay("app/api/me/route.ts");

    expect(webMeHelper).toBe(overlayMeHelper);
    expect(webMe).toBe(overlayMe);
    expect(webMeHelper).toContain("display_name");
    expect(webMeHelper).toContain("picture");
  });
});
