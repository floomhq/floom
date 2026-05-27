import { writeFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import { createAuthenticatedClient, WorkerosApiError } from "../lib/api.js";
import { printJson, renderTable, warn } from "../lib/output.js";

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

export async function runsListCommand(options: {
  worker?: string;
  status?: string;
  limit?: number;
  json?: boolean;
}): Promise<number> {
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
  console.log(renderTable(
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
  ));
  return 0;
}

export async function runsShowCommand(runId: string, options: { json?: boolean }): Promise<number> {
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
  console.log(`Run: ${detail.id}`);
  console.log(`Worker: ${detail.worker_id}`);
  console.log(`Status: ${detail.status}`);
  if (detail.duration_ms !== undefined) console.log(`Duration: ${detail.duration_ms}ms`);
  if (detail.trigger_source) console.log(`Trigger: ${detail.trigger_source}`);
  if (detail.output && Object.keys(detail.output).length) {
    console.log("Output preview:");
    console.log(JSON.stringify(detail.output, null, 2));
  }
  if (detail.artifacts?.length) {
    console.log("Artifacts:");
    for (const artifact of detail.artifacts) {
      console.log(`- ${artifact.name} (${artifact.id})`);
    }
  }
  return 0;
}

export async function runsLogsCommand(runId: string, options: { follow?: boolean }): Promise<number> {
  const { client, credentials } = await createAuthenticatedClient();
  if (!options.follow) {
    const logs = (await client.requestJson("GET", `/runs/${encodeURIComponent(runId)}/logs`)) as Array<{
      timestamp: string;
      level: string;
      message: string;
    }>;
    for (const entry of logs) {
      console.log(`[${entry.timestamp}] ${entry.level.toUpperCase()}: ${entry.message}`);
    }
    return 0;
  }

  const response = await fetch(`${credentials.api_base}/runs/${encodeURIComponent(runId)}/events`, {
    method: "GET",
    headers: {
      accept: "text/event-stream",
      "x-floom-secret": credentials.api_secret,
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to follow logs: HTTP ${response.status}`);
  }
  if (!response.body) {
    throw new Error("Events response body is missing");
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
          console.log(event);
          continue;
        }
        const typed = event as { type?: string; status?: string; data?: { status?: string; type?: string } };
        console.log(JSON.stringify(event));
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
}

export async function runsDownloadCommand(runId: string): Promise<number> {
  const { client } = await createAuthenticatedClient();
  try {
    const payload = await client.requestBuffer("GET", `/runs/${encodeURIComponent(runId)}/download`);
    const outputPath = join(resolvePath(process.cwd()), `run-${runId}.zip`);
    await writeFile(outputPath, payload);
    console.log(`Saved ${outputPath}`);
    return 0;
  } catch (error) {
    if (error instanceof WorkerosApiError && error.status === 404) {
      console.log(warn("TODO: /runs/<id>/download is not available yet. This command will be enabled after S12 lands."));
      return 0;
    }
    throw error;
  }
}
