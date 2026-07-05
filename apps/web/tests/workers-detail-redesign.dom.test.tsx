import { describe, expect, it, vi, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorkerSummary } from "@/lib/types";

const router = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  searchParams: "",
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(router.searchParams),
  useRouter: () => router,
  usePathname: () => "/",
}));

const TEST_TIMEOUT = 15_000;
const WORKERS_LIST_QUERY_OPTS = { include_archived: true } as const;
const WORKERS_LIST_QUERY_KEY = ["workers", { ...WORKERS_LIST_QUERY_OPTS, workspace_id: "local-default" }] as const;

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
  last_run: {
    id: "fresh-run",
    worker_id: WORKER_ID,
    status: "completed",
    trigger_source: "schedule",
    created_at: "2026-06-22T12:00:00Z",
  },
  recent_stats: { last_run_at: "2026-06-22T12:00:00Z", runs_7d: 7, success_rate_7d: 1 },
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
  getPersistedActiveWorkspaceId: vi.fn(() => "local-default"),
  api: {
    me: vi.fn().mockResolvedValue({ user_id: "u1", email: "owner@example.com" }),
    workers: {
      list: vi.fn().mockResolvedValue([worker]),
      get: vi.fn().mockResolvedValue(workerDetail),
      listVersions: vi.fn().mockResolvedValue([]),
      alerts: { list: vi.fn().mockResolvedValue([]), create: vi.fn(), remove: vi.fn() },
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
  router.searchParams = "";
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

async function openDetail(tab?: string, client = makeQueryClient()) {
  router.searchParams = tab
    ? `sel=${encodeURIComponent(WORKER_ID)}&tab=${encodeURIComponent(tab)}`
    : "";
  const { default: WorkersCollection } = await import("@/app/workers/WorkersCollection");
  render(
    <QueryClientProvider client={client}>
      <WorkersCollection initialWorkers={[worker as never]} />
    </QueryClientProvider>,
  );
  if (!tab) {
    fireEvent.click(await screen.findByRole("button", { name: /Invoice Reconciler/i }));
  }
  await waitFor(() => expect(document.querySelector(".c-dhead")).toBeTruthy());
  return client;
}

function classIncludes(el: Element, value: string): boolean {
  return typeof el.getAttribute("class") === "string" && el.getAttribute("class")!.includes(value);
}

function greyCardWrappers(scope: Element): Element[] {
  return Array.from(scope.querySelectorAll("*")).filter((el) =>
    classIncludes(el, "bg-[var(--bg-2)]") &&
    classIncludes(el, "rounded-[var(--radius-card)]")
  );
}

function detailBody(): Element {
  const body = document.querySelector(".c-dbody");
  expect(body).toBeTruthy();
  return body!;
}

function expectNoGreyCardWrappers(label: string) {
  const wrappers = greyCardWrappers(detailBody());
  expect(
    wrappers.map((el) => ({
      label,
      className: el.getAttribute("class"),
      text: el.textContent?.replace(/\s+/g, " ").trim().slice(0, 120),
    })),
  ).toHaveLength(0);
}

function tabName(label: string): RegExp {
  return new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`);
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
  }, TEST_TIMEOUT);

  it("keeps Overview and Setup panels free of grey-card detail wrappers", async () => {
    await openDetail();

    expectNoGreyCardWrappers("Overview");

    cleanup();
    await openDetail("Setup");

    for (const name of ["Inputs", "Alerts & webhooks", "Triggers", "Limits"]) {
      fireEvent.click(await screen.findByRole("tab", { name: tabName(name) }));
      await waitFor(() => expect(screen.getByRole("tab", { name: tabName(name) })).toHaveAttribute("aria-selected", "true"));
      expectNoGreyCardWrappers(name);
    }
  }, TEST_TIMEOUT);

  it("refreshes selected worker stats from the detail fetch instead of keeping stale list stats", async () => {
    const client = await openDetail();

    await waitFor(() => {
      const summary = document.querySelector(".c-dsum");
      expect(summary?.textContent).toMatch(/7\s*Runs/);
      expect(summary?.textContent).toMatch(/100%\s*Success/);
    });

    await waitFor(() => {
      const cached = client.getQueryData<WorkerSummary[]>(WORKERS_LIST_QUERY_KEY);
      expect(cached?.[0]?.recent_stats?.runs_7d).toBe(7);
      expect(cached?.[0]?.recent_stats?.success_rate_7d).toBe(1);
      expect(cached?.[0]?.last_run?.id).toBe("fresh-run");
    });
  }, TEST_TIMEOUT);

  it("opens Advanced before the View as YAML action navigates", async () => {
    await openDetail("Setup");

    fireEvent.click(screen.getByRole("link", { name: /View as YAML/i }));

    expect(window.localStorage.getItem("workeros:worker-advanced-open")).toBe("open");
    expect(router.replace).toHaveBeenCalledWith(`/workers?sel=${encodeURIComponent(WORKER_ID)}&tab=Source`);
  }, TEST_TIMEOUT);
});
