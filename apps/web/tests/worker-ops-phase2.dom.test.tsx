import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryProvider } from "@/components/providers/QueryProvider";

// Round-09 Phase 2 operator-gap fixes, behavioural on the REAL WorkersCollection:
//   FIX 1 (gap #1): Operations > Inputs "Save default inputs" persists via the
//          real api.workers.updateInputValues (PATCH input_values) AND the panel
//          loads the saved recipe from detail.input_values.
//   FIX 3 (gap #6): the header Pause/Resume action calls the real
//          api.workers.pause / api.workers.resume endpoints (not a YAML PUT).

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
  inputs: [{ name: "month", label: "Month", type: "string", required: true }],
  enabled: true,
  stage: "live",
  visibility: "private",
  permissions: { can_edit: true, can_run: true, can_delete: true, can_share: true },
  recent_stats: { last_run_at: "2026-06-16T00:00:00Z", runs_7d: 4 },
};
const workerDetail = {
  ...worker,
  // gap #1: the saved backend recipe is surfaced on the detail. The Inputs panel
  // must LOAD this (Default = the persisted recipe), not a write-blind guess.
  input_values: { month: "2026-05" },
  config: {
    id: WORKER_ID,
    name: "Revenue Reconciler",
    trigger: { type: "cron", cron: "0 9 1 * *" },
    runtime: { type: "python311", entrypoint: "run.py", runner: "e2b", mode: "agent", model: "claude-sonnet-4-5", limits: {} },
    inputs: worker.inputs,
    outputs: [],
    contexts: [],
    connections: ["stripe", "gmail"],
    secrets: [],
  },
  files: [{ path: "worker.yml", content: "name: Revenue Reconciler\n" }],
  recent_runs: [],
};

const updateInputValues = vi.fn().mockResolvedValue(workerDetail);
const pause = vi.fn().mockResolvedValue({ ...workerDetail, enabled: false });
const resume = vi.fn().mockResolvedValue({ ...workerDetail, enabled: true });

vi.mock("@/lib/api", () => ({
  api: {
    workers: {
      list: vi.fn().mockResolvedValue([worker]),
      get: vi.fn().mockResolvedValue(workerDetail),
      listVersions: vi.fn().mockResolvedValue([]),
      feedback: { list: vi.fn().mockResolvedValue([]), create: vi.fn(), delete: vi.fn() },
      updateInputValues,
      pause,
      resume,
    },
    contexts: { list: vi.fn().mockResolvedValue([]) },
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
  await waitFor(() => expect(document.querySelector(".c-dtabs")).toBeTruthy());
}

describe("R9 Phase 2 FIX 1 — default-inputs persistence (gap #1)", () => {
  it("Setup > Inputs loads the saved recipe and persists Default via updateInputValues", async () => {
    await openDetail();
    fireEvent.click(screen.getByRole("tab", { name: "Setup" }));
    // Inputs is the default Setup sub-tab; the Month field loads the saved
    // recipe value (input_values.month = "2026-05"), proving load-of-saved (the
    // gap #1 fix: Default reflects the persisted backend recipe, not blind).
    await waitFor(() => {
      const loaded = Array.from(document.querySelectorAll<HTMLInputElement>("input"))
        .some((el) => el.value === "2026-05");
      expect(loaded).toBe(true);
    });
    // The Save-default control exists and wires to the real PATCH endpoint.
    const saveBtn = await screen.findByRole("button", { name: /Save default inputs/i });
    fireEvent.click(saveBtn);
    await waitFor(() => expect(updateInputValues).toHaveBeenCalledTimes(1));
    const [calledId, calledValues] = updateInputValues.mock.calls[0];
    expect(calledId).toBe(WORKER_ID);
    // The saved value set carries the month key (loaded recipe, persisted back).
    expect(Object.prototype.hasOwnProperty.call(calledValues, "month")).toBe(true);
  });
});

describe("R9 Phase 2 FIX 3 — Pause/Resume real endpoints (gap #6)", () => {
  it("the header Pause action calls api.workers.pause, not a YAML PUT", async () => {
    await openDetail();
    fireEvent.click(await screen.findByRole("button", { name: /More worker actions/i }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /^Pause$/i }));
    await waitFor(() => expect(pause).toHaveBeenCalledWith(WORKER_ID));
    expect(resume).not.toHaveBeenCalled();
  });
});
