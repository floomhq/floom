import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { __deriveCounts } from "@/lib/useSelfOverviewItems";
import type { SystemOverviewAttentionItem } from "@/lib/types";

// The global AlertsBell was replaced by contextual count badges on the sidebar
// nav (Approvals / Connections / Runs), all sourced from one shared, polled
// overview fetch. These tests guard the derivation + the chrome wiring.

function read(rel: string): string {
  return fs.readFileSync(path.resolve(__dirname, "..", rel), "utf8");
}

function item(partial: Partial<SystemOverviewAttentionItem>): SystemOverviewAttentionItem {
  return {
    type: partial.type ?? "failing",
    message: partial.message ?? "",
    action_url: partial.action_url ?? "",
    ...partial,
  };
}

describe("nav badge count derivation (shared overview fetch)", () => {
  it("counts expired connections and sums failed-run clusters", () => {
    const items = [
      item({ kind: "connection_expired", type: "connection_expired" }),
      item({ kind: "connection_expired", type: "connection_expired" }),
      // expiring (not expired) must NOT count toward the connections badge
      item({ kind: "connection_expiring", type: "connection_expiring" }),
      item({ kind: "failing", recent_failure_count: 3 }),
      item({ type: "failure_cluster", recent_failure_count: 2 }),
    ];
    const counts = __deriveCounts(items);
    expect(counts.connectionsExpired).toBe(2);
    expect(counts.failedRuns).toBe(5);
  });

  it("a failing item with no recent_failure_count counts as 1", () => {
    const counts = __deriveCounts([item({ kind: "failing" })]);
    expect(counts.failedRuns).toBe(1);
  });

  it("returns zero counts when there is nothing to show", () => {
    const counts = __deriveCounts([]);
    expect(counts.connectionsExpired).toBe(0);
    expect(counts.failedRuns).toBe(0);
  });

  it("ignores setup_incomplete and other non-badge attention items", () => {
    const counts = __deriveCounts([
      item({ type: "setup_incomplete" }),
      item({ kind: "connection_expiring", type: "connection_expiring" }),
    ]);
    expect(counts.connectionsExpired).toBe(0);
    expect(counts.failedRuns).toBe(0);
  });
});

describe("sidebar nav badge wiring", () => {
  const sidebar = read("components/layout/sidebar.tsx");

  it("the three badge-bearing nav items are Runs, Approvals, Connections", () => {
    expect(sidebar).toContain('label: "Runs", icon: Clock, badge: "runs"');
    expect(sidebar).toContain('label: "Approvals", icon: CheckCircle, badge: "approvals"');
    expect(sidebar).toContain('label: "Connections", icon: Plug, badge: "connections"');
  });

  it("badges come from one shared overview/approvals source", () => {
    expect(sidebar).toContain("useNavBadgeSources");
    expect(sidebar).toContain('from "@/lib/useSelfOverviewItems"');
  });

  it("reuses the global Badge primitive (not a bespoke solid-blue pill)", () => {
    expect(sidebar).toContain('from "@/components/ui/badge"');
    expect(sidebar).toContain("<Badge");
    // No badge is rendered when its count is 0 (guarded by resolveNavBadge).
    expect(sidebar).toContain("resolveNavBadge");
  });

  it("attention badges use the amber (#C98A1A / --warning) token, not solid blue", () => {
    expect(sidebar).toContain("var(--warning)");
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
