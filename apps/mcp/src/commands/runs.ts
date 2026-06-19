import { writeFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import { createAuthenticatedClient, WorkerosApiError } from "../lib/api.js";
import { log, printJson, renderTable } from "../lib/output.js";

type RunSummary = {
  id: string;
  worker_id: string;
  status: string;
  trigger_source: string;
  created_at?: string;
  duration_ms?: number;
};

function parseSseChunk(chunk: string): unknown[] {
  const events: unknown[] = [];
  for (const block of chunk.split(/\r?\n\r?\n/)) {
    if (!block.trim()) continue;
    const dataLines = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());
    if (!dataLines.length) continue;
    const payload = dataLines.join("\n");
    try {
      events.push(JSON.parse(payload));
    } catch {
      events.push(payload);
    }
  }
  return events;
}

function handleAuthError(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Not logged in")) {
    log.err("Not authenticated.");
    process.stderr.write("Run: floom login\n");
    return 1;
  }
  if (error instanceof WorkerosApiError && (error.status === 401 || error.status === 403)) {
    log.err("Your session expired.");
    process.stderr.write("Re-run: floom login\n");
    return 1;
  }
  if (error instanceof WorkerosApiError && error.status && error.status >= 500) {
    log.err(`API error: ${message}`);
    process.stderr.write("Check API status, then retry. Report: https://github.com/floomhq/workeros/issues\n");
    return 1;
  }
  return null;
}

export async function runsListCommand(options: {
  worker?: string;
  status?: string;
  limit?: number;
  json?: boolean;
}): Promise<number> {
  try {
    const { client } = await createAuthenticatedClient();
    const runs = (await client.requestJson("GET", "/runs", {
      query: {
        worker_id: options.worker,
        status: options.status,
        limit: options.limit || 20,
        offset: 0,
      },
    })) as RunSummary[];

    if (options.json) {
      printJson(runs);
      return 0;
    }
    process.stdout.write(renderTable(
      runs.map((run) => ({
        id: run.id,
        worker: run.worker_id,
        status: run.status,
        trigger: run.trigger_source,
        created: run.created_at || "-",
      })),
      [
        { key: "id", label: "Run" },
        { key: "worker", label: "Worker" },
        { key: "status", label: "Status" },
        { key: "trigger", label: "Trigger" },
        { key: "created", label: "Created" },
      ],
    ) + "\n");
    return 0;
  } catch (error) {
    const handled = handleAuthError(error);
    if (handled !== null) return handled;
    throw error;
  }
}

export async function runsShowCommand(runId: string, options: { json?: boolean }): Promise<number> {
  try {
    const { client } = await createAuthenticatedClient();
    const run = await client.requestJson("GET", `/runs/${encodeURIComponent(runId)}`);
    if (options.json) {
      printJson(run);
      return 0;
    }
    const detail = run as {
      id: string;
      worker_id: string;
      status: string;
      duration_ms?: number;
      trigger_source?: string;
      output?: Record<string, unknown>;
      artifacts?: Array<{ id: string; name: string }>;
    };
    log.heading(`Run ${detail.id}`);
    log.kv("Worker", detail.worker_id);
    log.kv("Status", detail.status);
    if (detail.duration_ms !== undefined) log.kv("Duration", `${detail.duration_ms}ms`);
    if (detail.trigger_source) log.kv("Trigger", detail.trigger_source);
    if (detail.output && Object.keys(detail.output).length) {
      log.blank();
      log.info("Output:");
      process.stdout.write(JSON.stringify(detail.output, null, 2) + "\n");
    }
    if (detail.artifacts?.length) {
      log.blank();
      log.info("Artifacts:");
      for (const artifact of detail.artifacts) {
        log.step(`${artifact.name} (${artifact.id})`);
      }
    }
    return 0;
  } catch (error) {
    if (error instanceof WorkerosApiError && error.status === 404) {
      log.err(`Run '${runId}' not found.`);
      log.info("List recent runs: floom runs list");
      return 1;
    }
    const handled = handleAuthError(error);
    if (handled !== null) return handled;
    throw error;
  }
}

export async function runsLogsCommand(runId: string, options: { follow?: boolean }): Promise<number> {
  try {
    const { client, credentials } = await createAuthenticatedClient();
    if (!options.follow) {
      const logs = (await client.requestJson("GET", `/runs/${encodeURIComponent(runId)}/logs`)) as Array<{
        timestamp: string;
        level: string;
        message: string;
      }>;
      for (const entry of logs) {
        process.stdout.write(`[${entry.timestamp}] ${entry.level.toUpperCase()}: ${entry.message}\n`);
      }
      return 0;
    }

    // SSE follow needs a raw fetch (not requestJson), but we still want the
    // hosted JWT + workspace header in hosted mode and x-floom-secret in OSS
    // mode. authHeaders() resolves the right pair; the engine is mounted
    // under /api on the cloud app, so prefix the events path there.
    const eventsPath = credentials.mode === "cloud"
      ? `/api/runs/${encodeURIComponent(runId)}/events`
      : `/runs/${encodeURIComponent(runId)}/events`;
    const authHeaders = await client.authHeaders();
    const response = await fetch(`${credentials.api_base}${eventsPath}`, {
      method: "GET",
      headers: {
        accept: "text/event-stream",
        ...authHeaders,
      },
    });
    if (!response.ok) {
      log.err(`Failed to follow logs: HTTP ${response.status}`);
      log.info("Check run status: floom runs show " + runId);
      return 1;
    }
    if (!response.body) {
      log.err("Events response body is missing");
      log.info("Check run status: floom runs show " + runId);
      return 1;
    }

    const terminalStatuses = new Set(["completed", "failed", "error", "approved", "rejected"]);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() || "";
      for (const block of blocks) {
        for (const event of parseSseChunk(block)) {
          if (typeof event === "string") {
            process.stdout.write(event + "\n");
            continue;
          }
          const typed = event as { type?: string; status?: string; data?: { status?: string; type?: string } };
          process.stdout.write(JSON.stringify(event) + "\n");
          const status = typed.status || typed.data?.status;
          const type = typed.type || typed.data?.type;
          if (type === "close" || (status && terminalStatuses.has(status))) {
            await reader.cancel();
            return 0;
          }
        }
      }
    }
    return 0;
  } catch (error) {
    const handled = handleAuthError(error);
    if (handled !== null) return handled;
    throw error;
  }
}

export async function runsDownloadCommand(runId: string): Promise<number> {
  try {
    const { client } = await createAuthenticatedClient();
    try {
      const payload = await client.requestBuffer("GET", `/runs/${encodeURIComponent(runId)}/download`);
      const outputPath = join(resolvePath(process.cwd()), `run-${runId}.zip`);
      await writeFile(outputPath, payload);
      log.ok(`Saved ${outputPath}`);
      return 0;
    } catch (error) {
      if (error instanceof WorkerosApiError && error.status === 404) {
        log.warn("Run download is not yet available for this run.");
        log.info("View run details: floom runs show " + runId);
        return 0;
      }
      throw error;
    }
  } catch (error) {
    const handled = handleAuthError(error);
    if (handled !== null) return handled;
    throw error;
  }
}
