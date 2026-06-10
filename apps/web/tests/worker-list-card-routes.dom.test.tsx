/**
 * #843 — WorkerListCard's play button linked to /workers/{id}/runs, a route
 * with no Next.js page (only /workers/[id]/page.tsx exists) — clicking it
 * 404'd. Fix: the play button links to the worker detail page, where a run
 * can be started.
 *
 * Run: cd apps/web && npx vitest run tests/worker-list-card-routes.dom.test.tsx
 */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { WorkerListCard } from "@/components/emily/cards/WorkerListCard";
import type { WorkerListCard as WorkerListCardType } from "@/lib/emily-chat-types";

const card: WorkerListCardType = {
  kind: "worker-list",
  callId: "c1",
  card_id: "c1",
  status: "completed",
  workers: [{ id: "w1", name: "My worker", trigger: "manual", enabled: true }],
};

describe("WorkerListCard routes (#843)", () => {
  it("does not link to the non-existent /workers/{id}/runs route", () => {
    const { container } = render(<WorkerListCard card={card} />);
    const hrefs = Array.from(container.querySelectorAll("a")).map((a) =>
      a.getAttribute("href")
    );
    expect(hrefs.length).toBeGreaterThan(0);
    expect(hrefs.some((h) => h?.endsWith("/runs"))).toBe(false);
  });

  it("play button targets the worker detail page", () => {
    const { container } = render(<WorkerListCard card={card} />);
    const play = Array.from(container.querySelectorAll("a")).find(
      (a) => a.getAttribute("title") === "Run"
    );
    expect(play?.getAttribute("href")).toBe("/workers/w1");
  });
});
