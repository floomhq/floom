import { createAuthenticatedClient, WorkerosApiError } from "../lib/api.js";
import { log, printJson, renderTable } from "../lib/output.js";

type WorkerSummary = {
  id: string;
  name: string;
  status: string;
  triggers?: string[];
  last_run?: { created_at?: string };
};

type WorkerDetail = {
  id: string;
  name: string;
  description?: string;
  is_example?: boolean;
  config?: {
    runtime?: { entrypoint?: string };
    connections?: string[];
    secrets?: string[];
    triggers?: Array<{ type: string }>;
  };
  recent_runs?: Array<{ id: string; status: string; created_at?: string; duration_ms?: number }>;
};

function emitError(message: string, hint: string, json?: boolean): number {
  if (json) {
    // In JSON mode: keep stdout clean; write error to stderr only
    process.stderr.write(`{"error": ${JSON.stringify(message)}, "hint": ${JSON.stringify(hint)}}\n`);
  } else {
    log.err(message);
    log.info(hint);
  }
  return 1;
}

export async function workersListCommand(options: { json?: boolean }): Promise<number> {
  try {
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
    process.stdout.write(renderTable(rows, [
      { key: "Name", label: "Name" },
      { key: "Status", label: "Status" },
      { key: "Last run", label: "Last run" },
      { key: "Triggers", label: "Triggers" },
    ]) + "\n");
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Not logged in")) {
      return emitError("Not authenticated.", "Run: floom login", options.json);
    }
    if (error instanceof WorkerosApiError && (error.status === 401 || error.status === 403)) {
      return emitError("Your session expired.", "Re-run: floom login", options.json);
    }
    if (error instanceof WorkerosApiError && error.status && error.status >= 500) {
      return emitError(`API error: ${message}`, "Check API status, then retry. Report: https://github.com/floomhq/workeros/issues", options.json);
    }
    throw error;
  }
}

export async function workersShowCommand(workerId: string, options: { json?: boolean }): Promise<number> {
  try {
    const { client } = await createAuthenticatedClient();
    const worker = (await client.requestJson("GET", `/workers/${encodeURIComponent(workerId)}`)) as WorkerDetail;
    if (options.json) {
      printJson(worker);
      return 0;
    }
    process.stdout.write(`${worker.name} (${worker.id})\n`);
    if (worker.description) process.stdout.write(`${worker.description}\n`);
    process.stdout.write(`Entry: ${worker.config?.runtime?.entrypoint || "unknown"}\n`);
    process.stdout.write(`Connections: ${(worker.config?.connections || []).join(", ") || "none"}\n`);
    const runs = (worker.recent_runs || []).slice(0, 5);
    if (runs.length) {
      process.stdout.write("\n");
      process.stdout.write("Recent runs:\n");
      process.stdout.write(renderTable(
        runs.map((run) => ({ id: run.id, status: run.status, created_at: run.created_at || "-" })),
        [
          { key: "id", label: "Run" },
          { key: "status", label: "Status" },
          { key: "created_at", label: "Created" },
        ],
      ) + "\n");
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Not logged in")) {
      return emitError("Not authenticated.", "Run: floom login", options.json);
    }
    if (error instanceof WorkerosApiError && error.status === 404) {
      return emitError(`Worker '${workerId}' not found.`, "List available workers: floom workers list", options.json);
    }
    if (error instanceof WorkerosApiError && (error.status === 401 || error.status === 403)) {
      return emitError("Your session expired.", "Re-run: floom login", options.json);
    }
    if (error instanceof WorkerosApiError && error.status && error.status >= 500) {
      return emitError(`API error: ${message}`, "Check API status, then retry. Report: https://github.com/floomhq/workeros/issues", options.json);
    }
    throw error;
  }
}

function humanizeAge(isoDate: string | undefined): string {
  if (!isoDate) return "never";
  const ms = Date.now() - new Date(isoDate).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function humanizeDuration(ms: number | undefined): string {
  if (ms === undefined) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export async function workersInfoCommand(workerId: string, options: { json?: boolean }): Promise<number> {
  try {
    const { client } = await createAuthenticatedClient();
    const worker = (await client.requestJson("GET", `/workers/${encodeURIComponent(workerId)}`)) as WorkerDetail;
    if (options.json) {
      printJson(worker);
      return 0;
    }

    const label = worker.is_example ? "  [Example]" : "";
    log.heading(`${worker.name}${label}`);

    if (worker.description) {
      log.kv("Description", worker.description);
    }

    const triggers = (worker.config?.triggers || []).map((t) => t.type).join(", ");
    log.kv("Trigger", triggers || "Manual run");

    const connections = (worker.config?.connections || []).join(", ");
    log.kv("Connections", connections || "none");

    const secrets = (worker.config?.secrets || []).join(", ");
    log.kv("Secrets needed", secrets || "none");

    const recent = (worker.recent_runs || []).slice(0, 20);
    if (recent.length > 0) {
      const lastRun = recent[0];
      const age = humanizeAge(lastRun.created_at);
      const dur = humanizeDuration(lastRun.duration_ms);
      const durStr = dur ? ` (${dur})` : "";
      log.kv("Last run", `${age} — ${lastRun.status}${durStr}`);

      const successCount = recent.filter((r) => r.status === "completed" || r.status === "approved" || r.status === "success").length;
      const pct = Math.round((successCount / recent.length) * 100);
      log.kv("Recent success", `${successCount}/${recent.length} (${pct}%)`);
    } else {
      log.kv("Last run", "never");
    }

    log.blank();
    log.info(`Try: floom run ${workerId}`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Not logged in")) {
      return emitError("Not authenticated.", "Run: floom login", options.json);
    }
    if (error instanceof WorkerosApiError && error.status === 404) {
      return emitError(`Worker '${workerId}' not found.`, "List available workers: floom workers list", options.json);
    }
    if (error instanceof WorkerosApiError && (error.status === 401 || error.status === 403)) {
      return emitError("Your session expired.", "Re-run: floom login", options.json);
    }
    if (error instanceof WorkerosApiError && error.status && error.status >= 500) {
      return emitError(`API error: ${message}`, "Check API status, then retry. Report: https://github.com/floomhq/workeros/issues", options.json);
    }
    throw error;
  }
}
