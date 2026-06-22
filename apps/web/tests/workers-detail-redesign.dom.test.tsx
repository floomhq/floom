import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryProvider } from "@/components/providers/QueryProvider";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
}));

const WORKER_ID = "invoice-reconciler";
const worker = {
  id: WORKER_ID,
  name: "Invoice Reconciler",
  description: "Reconciles invoices against Stripe payouts.",
  tags: ["finance"],
  status: "healthy",
  trigger_type: "cron",
  runner: "e2b",
  runtime: "python311",
  triggers: [],
  triggers_spec: [{ type: "cron", cron: "0 9 * * *", timezone: "Europe/Berlin" }],
  connections: ["stripe", "gmail"],
  inputs: [{ name: "period", label: "Period", type: "string", required: true }],
  enabled: true,
  stage: "live",
  visibility: "private",
  permissions: { can_edit: true, can_run: true, can_delete: true, can_share: true },
  recent_stats: { last_run_at: "2026-06-21T09:00:00Z", runs_7d: 6, success_rate_7d: 0.98 },
};

const workerDetail = {
  ...worker,
  config: {
    id: WORKER_ID,
    name: "Invoice Reconciler",
    trigger: { type: "cron", cron: "0 9 * * *", timezone: "Europe/Berlin" },
    runtime: {
      type: "python311",
      entrypoint: "run.py",
      runner: "e2b",
      mode: "agent",
      model: "claude-sonnet-4-5",
      limits: { max_cost_usd: 2, max_cost_usd_per_day: 25, timeout_seconds: 300, max_retries: 2 },
    },
    inputs: worker.inputs,
    outputs: [],
    contexts: ["finance-sops"],
    connections: ["stripe", "gmail"],
    secrets: [],
  },
  files: [{ path: "worker.yml", content: "name: Invoice Reconciler\n" }],
  recent_runs: [],
};

vi.mock("@/lib/api", () => ({
  api: {
    workers: {
      list: vi.fn().mockResolvedValue([worker]),
      get: vi.fn().mockResolvedValue(workerDetail),
      listVersions: vi.fn().mockResolvedValue([]),
      feedback: { list: vi.fn().mockResolvedValue([]), create: vi.fn(), delete: vi.fn() },
    },
    contexts: { list: vi.fn().mockResolvedValue([{ name: "finance-sops" }]) },
  },
}));

vi.mock("@/lib/useApprovalsSync", () => ({
  notifyApprovalsChanged: vi.fn(),
  useApprovalsListSync: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

async function openDetail() {
  const { default: WorkersCollection } = await import("@/app/workers/WorkersCollection");
  render(
    <QueryProvider>
      <WorkersCollection initialWorkers={[worker as never]} />
    </QueryProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: /Invoice Reconciler/i }));
  await waitFor(() => expect(document.querySelector(".c-dhead")).toBeTruthy());
}

function classIncludes(el: Element, value: string): boolean {
  return typeof el.getAttribute("class") === "string" && el.getAttribute("class")!.includes(value);
}

describe("Workers detail redesign register", () => {
  it("elevates status and Run into the header and removes the old grey limits meta card", async () => {
    await openDetail();

    const header = document.querySelector(".c-dhead")!;
    const status = header.querySelector(".c-pill.run");
    expect(status?.textContent).toContain("Live");
    const run = screen.getByRole("button", { name: /^Run$/ });
    expect(run.className).toContain("c-addbtn");

    fireEvent.click(screen.getByRole("tab", { name: "Setup" }));
    fireEvent.click(await screen.findByRole("tab", { name: "Limits" }));

    await waitFor(() => expect(screen.getByText("Spend")).toBeTruthy());
    const body = document.querySelector(".c-dbody")!;
    expect(body.querySelector(".c-dsum")).toBeTruthy();
    expect(body.querySelector(".c-dgrp")).toBeTruthy();
    expect(body.querySelector(".c-drow")).toBeTruthy();
    expect(screen.getByText("Per run")).toBeTruthy();
    expect(screen.getAllByText("300").length).toBeGreaterThan(0);

    const oldGreyMetaCards = Array.from(body.querySelectorAll("*")).filter((el) =>
      classIncludes(el, "grid-cols-[minmax(96px,140px)_minmax(0,1fr)]") &&
      classIncludes(el, "bg-[var(--bg-2)]") &&
      classIncludes(el, "rounded-[var(--radius-card)]")
    );
    expect(oldGreyMetaCards).toHaveLength(0);
  });
});
