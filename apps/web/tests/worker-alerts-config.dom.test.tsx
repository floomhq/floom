import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryProvider } from "@/components/providers/QueryProvider";

// #1677 — the Alerts & webhooks panel is a real config form, wired to the
// per-worker alerts CRUD (GET/POST/DELETE /workers/{id}/alerts). This test
// drives the REAL WorkersCollection:
//   - empty state renders when no alerts are configured
//   - the add-alert form persists via api.workers.alerts.create with the
//     selected events + webhook URL
//   - after save the list re-loads (api.workers.alerts.list called again)
//   - an existing alert can be removed via api.workers.alerts.remove

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
}));

const WORKER_ID = "alert-wk";
const worker = {
  id: WORKER_ID,
  name: "Alerting Worker",
  description: "Worker used to verify the alerts config form.",
  tags: [],
  status: "healthy",
  trigger_type: "manual",
  runner: "e2b",
  triggers: [],
  triggers_spec: [],
  connections: [],
  enabled: true,
  stage: "live",
  visibility: "workspace" as const,
  permissions: { can_edit: true, can_run: true, can_delete: true, can_share: true },
  recent_stats: { last_run_at: "2026-06-18T00:00:00Z", runs_7d: 1 },
};
const workerDetail = {
  ...worker,
  config: {
    id: WORKER_ID,
    name: "Alerting Worker",
    trigger: { type: "manual" },
    runtime: { type: "skill", entrypoint: "SKILL.md", runner: "e2b", mode: "agent", model: "claude-sonnet-4-6" },
    inputs: [],
    outputs: [],
    contexts: [],
    connections: [],
    secrets: [],
  },
  files: [{ path: "worker.yml", content: "name: Alerting Worker\n" }],
  recent_runs: [],
};

const createdAlert = {
  id: "alrt_abc123",
  worker_id: WORKER_ID,
  url: "https://hooks.example.com/wk",
  email_to: null,
  on: ["failed"],
  description: null,
  created_at: "2026-06-18T00:00:00Z",
};

// alerts.list returns empty first, then the created alert after save.
const alertsList = vi.fn();
const alertsCreate = vi.fn().mockResolvedValue(createdAlert);
const alertsRemove = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/api", () => ({
  api: {
    workers: {
      list: vi.fn().mockResolvedValue([worker]),
      get: vi.fn().mockResolvedValue(workerDetail),
      listVersions: vi.fn().mockResolvedValue([]),
      feedback: { list: vi.fn().mockResolvedValue([]), create: vi.fn(), delete: vi.fn() },
      alerts: { list: alertsList, create: alertsCreate, remove: alertsRemove },
    },
    contexts: { list: vi.fn().mockResolvedValue([]) },
  },
}));

vi.mock("@/lib/useApprovalsSync", () => ({
  notifyApprovalsChanged: vi.fn(),
  useApprovalsListSync: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  alertsList.mockResolvedValue([]); // default: no alerts configured
});

async function openAlertsPanel() {
  const { default: WorkersCollection } = await import("@/app/workers/WorkersCollection");
  render(
    <QueryProvider>
      <WorkersCollection initialWorkers={[worker as never]} />
    </QueryProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: /Alerting Worker/i }));
  fireEvent.click(await screen.findByRole("tab", { name: "Setup" }));
  fireEvent.click(await screen.findByRole("tab", { name: "Alerts & webhooks" }));
}

describe("#1677 — Alerts & webhooks config form", () => {
  it("renders the empty state and the add-alert form when no alerts exist", async () => {
    await openAlertsPanel();
    await waitFor(() => expect(alertsList).toHaveBeenCalledWith(WORKER_ID));
    expect(await screen.findByText(/No alerts yet/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save alert/i })).toBeInTheDocument();
  });

  it("persists a webhook alert via api.workers.alerts.create and reloads the list", async () => {
    await openAlertsPanel();
    await waitFor(() => expect(alertsList).toHaveBeenCalled());

    // Enter a webhook URL (a channel is required to enable Save).
    const urlInput = await screen.findByPlaceholderText(/hooks\.example\.com/i);
    fireEvent.change(urlInput, { target: { value: "https://hooks.example.com/wk" } });

    // After save the list call should return the created alert.
    alertsList.mockResolvedValue([createdAlert]);

    fireEvent.click(screen.getByRole("button", { name: /Save alert/i }));

    await waitFor(() => expect(alertsCreate).toHaveBeenCalledTimes(1));
    const [calledId, body] = alertsCreate.mock.calls[0];
    expect(calledId).toBe(WORKER_ID);
    expect(body.url).toBe("https://hooks.example.com/wk");
    expect(body.on).toEqual(["failed"]); // default selected event

    // Post-save reload surfaces the new alert in the list.
    await waitFor(() =>
      expect(screen.getByText("https://hooks.example.com/wk")).toBeInTheDocument(),
    );
  });

  it("removes a configured alert via api.workers.alerts.remove", async () => {
    alertsList.mockResolvedValue([createdAlert]);
    await openAlertsPanel();

    const removeBtn = await screen.findByRole("button", { name: /Remove alert/i });
    fireEvent.click(removeBtn);

    await waitFor(() =>
      expect(alertsRemove).toHaveBeenCalledWith(WORKER_ID, createdAlert.id),
    );
  });
});
