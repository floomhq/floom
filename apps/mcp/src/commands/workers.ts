import { createAuthenticatedClient } from "../lib/api.js";
import { printJson, renderTable } from "../lib/output.js";

type WorkerSummary = {
  id: string;
  name: string;
  status: string;
  triggers?: string[];
  last_run?: { created_at?: string };
};

export async function workersListCommand(options: { json?: boolean }): Promise<number> {
  const { client } = await createAuthenticatedClient();
  const workers = (await client.requestJson("GET", "/workers")) as WorkerSummary[];
  if (options.json) {
    printJson(workers);
    return 0;
  }
  const rows = workers.map((worker) => ({
    Name: worker.name || worker.id,
    Status: worker.status,
    "Last run": worker.last_run?.created_at || "-",
    Triggers: (worker.triggers || []).join(", ") || "-",
  }));
  console.log(renderTable(rows, [
    { key: "Name", label: "Name" },
    { key: "Status", label: "Status" },
    { key: "Last run", label: "Last run" },
    { key: "Triggers", label: "Triggers" },
  ]));
  return 0;
}

export async function workersShowCommand(workerId: string, options: { json?: boolean }): Promise<number> {
  const { client } = await createAuthenticatedClient();
  const worker = (await client.requestJson("GET", `/workers/${encodeURIComponent(workerId)}`)) as {
    id: string;
    name: string;
    description?: string;
    config?: { runtime?: { entrypoint?: string }; connections?: string[] };
    recent_runs?: Array<{ id: string; status: string; created_at?: string }>;
  };
  if (options.json) {
    printJson(worker);
    return 0;
  }
  console.log(`${worker.name} (${worker.id})`);
  if (worker.description) console.log(worker.description);
  console.log(`Entry: ${worker.config?.runtime?.entrypoint || "unknown"}`);
  console.log(`Connections: ${(worker.config?.connections || []).join(", ") || "none"}`);
  const runs = (worker.recent_runs || []).slice(0, 5);
  if (runs.length) {
    console.log("");
    console.log("Recent runs:");
    console.log(renderTable(
      runs.map((run) => ({ id: run.id, status: run.status, created_at: run.created_at || "-" })),
      [
        { key: "id", label: "Run" },
        { key: "status", label: "Status" },
        { key: "created_at", label: "Created" },
      ],
    ));
  }
  return 0;
}
