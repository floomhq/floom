import { describe, it, expect } from "vitest";
import { getCardHref } from "@/lib/useChatStream";
import type { ToolCard } from "@/lib/emily-chat-types";

// #825: Emily answer cards map to real in-app router hrefs.
const base = { callId: "c1", card_id: "card1", status: "completed" as const };

function card(extra: Partial<ToolCard> & { kind: ToolCard["kind"] }): ToolCard {
  return { ...base, ...extra } as ToolCard;
}

describe("getCardHref", () => {
  it("worker-create → split-pane worker detail (null without id)", () => {
    expect(getCardHref(card({ kind: "worker-create", workerName: "W", workerId: "w_1", step: "ready" }))).toBe(
      "/workers?sel=w_1"
    );
    expect(getCardHref(card({ kind: "worker-create", workerName: "W", step: "drafting" }))).toBeNull();
  });

  it("run → split-pane run detail (null without id)", () => {
    expect(getCardHref(card({ kind: "run", workerName: "W", runId: "run_9" }))).toBe("/runs?sel=run_9");
    expect(getCardHref(card({ kind: "run", workerName: "W" }))).toBeNull();
  });

  it("artifact → its run output", () => {
    expect(
      getCardHref(
        card({ kind: "artifact", runId: "run_5", artifactId: "a1", name: "x.png", downloadUrl: "/d" })
      )
    ).toBe("/runs?sel=run_5&tab=Output");
  });

  it("approval → /approvals?sel={id} or /approvals", () => {
    expect(getCardHref(card({ kind: "approval", workerName: "W", action: "send", approved: null, approvalId: "ap_1" }))).toBe(
      "/approvals?sel=ap_1"
    );
    expect(getCardHref(card({ kind: "approval", workerName: "W", action: "send", approved: null }))).toBe("/approvals");
  });

  it("list/connection cards map to their pages", () => {
    expect(getCardHref(card({ kind: "connect-service", appName: "hubspot", label: "HubSpot", connected: false }))).toBe(
      "/connections"
    );
    expect(getCardHref(card({ kind: "worker-list", workers: [] }))).toBe("/workers");
    expect(getCardHref(card({ kind: "runs-list", runs: [] }))).toBe("/runs");
  });

  it("generic tool cards have no concrete href", () => {
    expect(getCardHref(card({ kind: "generic", toolName: "x", title: "X" }))).toBeNull();
  });
});
