import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryProvider } from "@/components/providers/QueryProvider";

// R9 worker-detail FIX 1 + FIX 2 — structural proof on the REAL WorkersCollection.
//   FIX 1: the advanced tab group ("Advanced") is a visible affordance ON the
//          primary tab row (inside .c-dtabs), not a hidden header control.
//   FIX 2: in Operations, the second-row tabs (.c-dtabs2) stack flush under the
//          primary row — no "Visual editor of worker.yml" framing text or gap
//          element sits BETWEEN .c-dtabs and .c-dtabs2.

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
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

describe("R9 worker-detail FIX 1 — Advanced group is visible ON the tab row", () => {
  it("renders an 'Advanced' affordance inside the primary .c-dtabs row", async () => {
    await openDetail();
    const tabRow = document.querySelector(".c-dtabs");
    expect(tabRow).toBeTruthy();
    // The Advanced trigger lives inside the tab row (via tabsTrailing), not in
    // the detail header actions.
    const adv = tabRow!.querySelector("[aria-label='Advanced tabs']");
    expect(adv).toBeTruthy();
    expect(adv!.textContent).toMatch(/Advanced/);
  });

  it("opening Advanced lists the four advanced tabs and selecting one pins it onto the row", async () => {
    await openDetail();
    fireEvent.click(await screen.findByRole("button", { name: /Advanced tabs/i }));
    expect(await screen.findByRole("menuitemcheckbox", { name: "Source" })).toBeTruthy();
    expect(screen.getByRole("menuitemcheckbox", { name: "Versions" })).toBeTruthy();
    expect(screen.getByRole("menuitemcheckbox", { name: "Brain" })).toBeTruthy();
    expect(screen.getByRole("menuitemcheckbox", { name: "Tools" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Versions" }));
    // Versions now renders as a real tab on the primary row.
    await waitFor(() => expect(screen.getByRole("tab", { name: "Versions" })).toBeTruthy());
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
