import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryProvider } from "@/components/providers/QueryProvider";

// R9 worker-detail FIX 1 + FIX 2 — structural proof on the REAL WorkersCollection.
//   FIX 1: the advanced tab group ("Advanced") is a visible affordance ON the
//          primary tab row (inside .c-dtabs), directly after the operator tabs —
//          not far-right, not a dropdown menu. Clicking once reveals ALL advanced
//          tabs inline; clicking again collapses them (disclosure, not pick-one).
//   FIX 2: in Setup, the second-row tabs (.c-dtabs2) stack flush under the
//          primary row — no "Visual editor of worker.yml" framing text or gap
//          element sits BETWEEN .c-dtabs and .c-dtabs2.

// Mutable search string so a test can simulate a deep-linked active tab
// (?sel=...&tab=Source) before mounting.
let mockSearch = "";
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(mockSearch),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
}));

const WORKER_ID = "rev-rec";
const worker = {
  id: WORKER_ID,
  name: "Revenue Reconciler",
  description: "Reconciles monthly revenue against the ledger.",
  tags: ["finance"],
  status: "healthy",
  trigger_type: "cron",
  runner: "e2b",
  triggers: [],
  triggers_spec: [{ type: "cron", cron: "0 9 1 * *" }],
  connections: ["stripe", "gmail"],
  inputs: [
    { name: "month", label: "Month", type: "string", required: true },
    { name: "ledger_csv", label: "Ledger CSV", type: "file", required: false },
  ],
  enabled: true,
  stage: "live",
  visibility: "private",
  permissions: { can_edit: true, can_run: true, can_delete: true, can_share: true },
  recent_stats: { last_run_at: "2026-06-16T00:00:00Z", runs_7d: 4 },
};
const workerDetail = {
  ...worker,
  config: {
    id: WORKER_ID,
    name: "Revenue Reconciler",
    trigger: { type: "cron", cron: "0 9 1 * *" },
    runtime: { type: "python311", entrypoint: "run.py", runner: "e2b", mode: "agent", model: "claude-sonnet-4-5", limits: { max_cost_usd: 2.5, timeout_seconds: 600, max_retries: 2 } },
    inputs: worker.inputs,
    outputs: [],
    contexts: ["finance-policies"],
    connections: ["stripe", "gmail"],
    secrets: [],
  },
  files: [{ path: "worker.yml", content: "name: Revenue Reconciler\n" }],
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
    contexts: { list: vi.fn().mockResolvedValue([{ name: "finance-policies" }]) },
  },
}));

vi.mock("@/lib/useApprovalsSync", () => ({
  notifyApprovalsChanged: vi.fn(),
  useApprovalsListSync: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  mockSearch = "";
});

async function openDetail() {
  const { default: WorkersCollection } = await import("@/app/workers/WorkersCollection");
  render(
    <QueryProvider>
      <WorkersCollection initialWorkers={[worker as never]} />
    </QueryProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: /Revenue Reconciler/i }));
  // The primary tab row exists.
  await waitFor(() => expect(document.querySelector(".c-dtabs")).toBeTruthy());
}

describe("R9 worker-detail FIX 1 — Advanced disclosure is inline on the tab row", () => {
  it("renders an 'Advanced' button inside the primary .c-dtabs row (not far-right / not a dropdown)", async () => {
    await openDetail();
    const tabRow = document.querySelector(".c-dtabs");
    expect(tabRow).toBeTruthy();
    // The Advanced button lives inside .c-dtabs-trailing which is a direct child
    // of the tab row — inline, not a far-right floating pill.
    const trailing = tabRow!.querySelector(".c-dtabs-trailing");
    expect(trailing).toBeTruthy();
    const adv = trailing!.querySelector("[aria-label='Show developer tabs']");
    expect(adv).toBeTruthy();
    expect(adv!.textContent).toMatch(/Advanced/);
    // It is a plain button, not a dropdown trigger.
    expect(adv!.tagName.toLowerCase()).toBe("button");
    // No checkmark/menuitemcheckbox inside the row.
    expect(tabRow!.querySelector('[role="menuitemcheckbox"]')).toBeNull();
  });

  it("clicking Advanced once reveals ALL advanced tabs (Source, Versions, Brain, Tools) as real tabs", async () => {
    await openDetail();
    // Initially no advanced tabs visible.
    expect(screen.queryByRole("tab", { name: "Source" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Versions" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Brain" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Tools" })).toBeNull();

    // Click Advanced — all four appear as real selectable tabs.
    const advBtn = await screen.findByRole("button", { name: /Show developer tabs/i });
    fireEvent.click(advBtn);
    await waitFor(() => expect(screen.getByRole("tab", { name: "Source" })).toBeTruthy());
    expect(screen.getByRole("tab", { name: "Versions" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Brain" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Tools" })).toBeTruthy();
  });

  it("clicking Advanced again collapses the advanced tabs", async () => {
    await openDetail();
    const advBtn = await screen.findByRole("button", { name: /Show developer tabs/i });

    // Expand.
    fireEvent.click(advBtn);
    await waitFor(() => expect(screen.getByRole("tab", { name: "Source" })).toBeTruthy());

    // Collapse — advanced tabs gone, button label reverts.
    const collapseBtn = screen.getByRole("button", { name: /Hide developer tabs/i });
    fireEvent.click(collapseBtn);
    await waitFor(() => expect(screen.queryByRole("tab", { name: "Source" })).toBeNull());
    expect(screen.queryByRole("tab", { name: "Versions" })).toBeNull();
  });
});

describe("R9 worker-detail FIX 2 — Setup tab rows stack tight", () => {
  it("has no .c-ops-frame between the primary row and the .c-dtabs2 second row", async () => {
    await openDetail();
    fireEvent.click(screen.getByRole("tab", { name: "Setup" }));
    const subRow = await waitFor(() => {
      const el = document.querySelector(".c-dtabs2");
      expect(el).toBeTruthy();
      return el!;
    });
    // The flush wrapper holds the second row and is the FIRST child of the
    // Setup panel — nothing (no framing text, no gap div) precedes it.
    const flush = document.querySelector(".c-ops-row-flush");
    expect(flush).toBeTruthy();
    expect(flush!.contains(subRow)).toBe(true);
    // The Operations panel's first element child is the flush row, i.e. the
    // second tab row is the first thing rendered (no intervening text/frame).
    const opsContainer = flush!.parentElement!;
    expect(opsContainer.firstElementChild).toBe(flush);
    // The c-ops-frame (visual-editor framing) is NOT a previous sibling of the
    // second tab row; it lives AFTER it (in the panel body).
    expect(flush!.previousElementSibling).toBeNull();
    const frame = document.querySelector(".c-ops-frame");
    if (frame) {
      // If present, the frame comes after the flush row, not between the rows.
      const pos = flush!.compareDocumentPosition(frame);
      expect(pos & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });
});
