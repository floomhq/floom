import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

// The global AlertsBell was replaced by a contextual pending-approvals badge on
// the sidebar nav. Runs and Connections intentionally do not show nav counts.

function read(rel: string): string {
  return fs.readFileSync(path.resolve(__dirname, "..", rel), "utf8");
}

describe("sidebar nav badge wiring", () => {
  const sidebar = read("components/layout/sidebar.tsx");

  it("only Approvals is badge-bearing in the sidebar nav", () => {
    expect(sidebar).toContain('label: "Runs", icon: Clock }');
    expect(sidebar).toContain('label: "Approvals", icon: CheckCircle, badge: "approvals"');
    expect(sidebar).toContain('label: "Connections", icon: Plug }');
    expect(sidebar).not.toContain('badge: "runs"');
    expect(sidebar).not.toContain('badge: "connections"');
  });

  it("badges come from the shared approvals source, not the overview alert source", () => {
    expect(sidebar).toContain("useNavBadgeSources");
    expect(sidebar).toContain('from "@/lib/useApprovalsSync"');
    expect(sidebar).not.toContain('from "@/lib/useSelfOverviewItems"');
  });

  it("reuses the global Badge primitive (not a bespoke solid-blue pill)", () => {
    expect(sidebar).toContain('from "@/components/ui/badge"');
    expect(sidebar).toContain("<Badge");
    // No badge is rendered when its count is 0 (guarded by resolveNavBadge).
    expect(sidebar).toContain("resolveNavBadge");
  });

  it("does not render amber attention badges in the nav", () => {
    expect(sidebar).not.toContain("var(--warning)");
  });
});

describe("alerts bell removed from chrome", () => {
  it("AppShell no longer imports or renders the bell", () => {
    const appShell = read("components/layout/AppShell.tsx");
    expect(appShell).not.toContain("AlertsBell");
    expect(appShell).not.toContain("GlobalAlertsBell");
  });

  it("sidebar (mobile top bar) no longer imports or renders the bell", () => {
    const sidebar = read("components/layout/sidebar.tsx");
    expect(sidebar).not.toContain("AlertsBell");
  });
});
