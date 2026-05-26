import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const DEFAULT_API_BASE = "https://workers-api.floom.dev";
const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "failed",
  "pending_approval",
  "approved",
  "rejected",
]);

type JsonObject = Record<string, unknown>;

class WorkerosApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "WorkerosApiError";
  }
}

function apiBase(): string {
  return (process.env.WORKEROS_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, "");
}

function apiSecret(): string {
  const secret = process.env.WORKEROS_API_SECRET;
  if (!secret) {
    throw new Error("WORKEROS_API_SECRET is required");
  }
  return secret;
}

function jsonResult(data: unknown, summary?: string): CallToolResult {
  const structuredContent =
    data && typeof data === "object" && !Array.isArray(data) ? (data as JsonObject) : { data };
  return {
    content: [
      {
        type: "text",
        text: summary ? `${summary}\n${JSON.stringify(data, null, 2)}` : JSON.stringify(data, null, 2),
      },
    ],
    structuredContent,
  };
}

async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return {};
  }
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return JSON.parse(text);
  }
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function buildUrl(path: string, query?: Record<string, string | number | undefined>): string {
  const url = new URL(`${apiBase()}${path}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function request(
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, string | number | undefined>,
): Promise<unknown> {
  const response = await fetch(buildUrl(path, query), {
    method,
    headers: {
      "accept": "application/json, text/event-stream",
      "content-type": "application/json",
      "x-floom-secret": apiSecret(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const parsed = await parseResponse(response);
  if (!response.ok) {
    const detail =
      typeof parsed === "object" && parsed && "detail" in parsed
        ? String((parsed as { detail: unknown }).detail)
        : JSON.stringify(parsed);
    throw new WorkerosApiError(
      `Workeros API ${method} ${path} failed with HTTP ${response.status}: ${detail}`,
      response.status,
      parsed,
    );
  }
  return parsed;
}

async function watchRunEvents(runId: string, timeoutMs: number): Promise<JsonObject> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const events: JsonObject[] = [];
  let status: string | undefined;
  let buffer = "";

  try {
    const response = await fetch(buildUrl(`/runs/${encodeURIComponent(runId)}/events`), {
      method: "GET",
      headers: {
        "accept": "text/event-stream",
        "x-floom-secret": apiSecret(),
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      const parsed = await parseResponse(response);
      throw new WorkerosApiError(
        `Workeros API GET /runs/${runId}/events failed with HTTP ${response.status}`,
        response.status,
        parsed,
      );
    }
    if (!response.body) {
      throw new WorkerosApiError("Workeros run events response did not include a body", response.status);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split(/\r?\n\r?\n/);
      buffer = chunks.pop() || "";
      for (const chunk of chunks) {
        const event = parseSseEvent(chunk);
        if (!event) {
          continue;
        }
        events.push(event);
        const candidate = event.status ?? (event.data && typeof event.data === "object" ? (event.data as JsonObject).status : undefined);
        if (typeof candidate === "string") {
          status = candidate;
        }
        if (status && TERMINAL_RUN_STATUSES.has(status)) {
          await reader.cancel();
          return { run_id: runId, status, events };
        }
      }
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new WorkerosApiError(`Timed out watching run ${runId} after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  return { run_id: runId, status: status || "unknown", events };
}

function parseSseEvent(chunk: string): JsonObject | null {
  const event: JsonObject = {};
  const dataLines: string[] = [];
  for (const line of chunk.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) {
      continue;
    }
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? "" : line.slice(separator + 1).trimStart();
    if (field === "data") {
      dataLines.push(value);
    } else {
      event[field] = value;
    }
  }

  if (dataLines.length) {
    const rawData = dataLines.join("\n");
    try {
      event.data = JSON.parse(rawData);
    } catch {
      event.data = rawData;
    }
    if (typeof event.data === "object" && event.data && "status" in event.data) {
      event.status = (event.data as JsonObject).status;
    }
  }

  return Object.keys(event).length ? event : null;
}

const workerIdSchema = z.object({
  id: z.string().min(1).describe("Workeros worker id."),
});

const runIdSchema = z.object({
  id: z.string().min(1).describe("Workeros run id."),
});

export function createServer(): McpServer {
  const server = new McpServer({
    name: "workeros-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    "workers.list",
    {
      title: "List Workers",
      description: "List Workeros workers.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => jsonResult(await request("GET", "/workers")),
  );

  server.registerTool(
    "workers.get",
    {
      title: "Get Worker",
      description: "Get a Workeros worker by id.",
      inputSchema: workerIdSchema.shape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ id }) => jsonResult(await request("GET", `/workers/${encodeURIComponent(id)}`)),
  );

  server.registerTool(
    "workers.create",
    {
      title: "Create Worker",
      description: "Create a Workeros worker from WorkerContract YAML and Python source. Capabilities are optional documentation and are not enforced by this MCP server.",
      inputSchema: {
        worker_yml: z.string().min(1).describe("WorkerContract YAML content."),
        run_py: z.string().min(1).describe("Python source for run.py."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ worker_yml, run_py }) =>
      jsonResult(await request("POST", "/workers", { worker_yml, run_py }), "Worker created."),
  );

  server.registerTool(
    "workers.update",
    {
      title: "Update Worker",
      description: "Update worker instance settings such as trigger, cron, input defaults, and documented capabilities.",
      inputSchema: {
        id: z.string().min(1).describe("Workeros worker id."),
        trigger_type: z.string().optional().describe("Trigger type, for example manual, cron, or webhook."),
        cron_expr: z.string().optional().describe("Cron expression for cron workers."),
        cron_timezone: z.string().optional().describe("IANA timezone for cron workers."),
        input_values: z.record(z.string(), z.unknown()).optional().describe("Saved default input values for future runs."),
        capabilities: z.record(z.string(), z.unknown()).optional().describe("Optional documented capabilities; not enforced."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ id, ...updates }) =>
      jsonResult(await request("PATCH", `/workers/${encodeURIComponent(id)}`, updates), "Worker updated."),
  );

  server.registerTool(
    "workers.delete",
    {
      title: "Delete Worker",
      description: "Delete a Workeros worker.",
      inputSchema: workerIdSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ id }) => jsonResult(await request("DELETE", `/workers/${encodeURIComponent(id)}`), "Worker deleted."),
  );

  server.registerTool(
    "workers.run",
    {
      title: "Run Worker",
      description: "Start a manual Workeros worker run.",
      inputSchema: {
        id: z.string().min(1).describe("Workeros worker id."),
        inputs: z.record(z.string(), z.unknown()).default({}).describe("Input values for this run."),
        trigger_source: z.string().default("manual").describe("Run trigger source."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ id, inputs, trigger_source }) =>
      jsonResult(
        await request("POST", `/workers/${encodeURIComponent(id)}/runs`, { inputs, trigger_source }),
        "Worker run started.",
      ),
  );

  server.registerTool(
    "runs.list",
    {
      title: "List Runs",
      description: "List Workeros runs, optionally filtered by worker id.",
      inputSchema: {
        worker_id: z.string().optional().describe("Optional worker id filter."),
        status: z.string().optional().describe("Optional run status filter."),
        limit: z.number().int().min(1).max(500).default(50).describe("Maximum runs to return."),
        offset: z.number().int().min(0).default(0).describe("Pagination offset."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ worker_id, status, limit, offset }) =>
      jsonResult(await request("GET", "/runs", undefined, { worker_id, status, limit, offset })),
  );

  server.registerTool(
    "runs.get",
    {
      title: "Get Run",
      description: "Get a Workeros run by id, including logs, outputs, artifacts, and approval status.",
      inputSchema: runIdSchema.shape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ id }) => jsonResult(await request("GET", `/runs/${encodeURIComponent(id)}`)),
  );

  server.registerTool(
    "runs.watch",
    {
      title: "Watch Run",
      description: "Read server-sent events for a Workeros run until a terminal status is reached.",
      inputSchema: {
        id: z.string().min(1).describe("Workeros run id."),
        timeout_ms: z.number().int().min(1000).max(600000).default(120000).describe("Maximum watch duration in milliseconds."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ id, timeout_ms }) => jsonResult(await watchRunEvents(id, timeout_ms), "Run watch completed."),
  );

  return server;
}

export async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`workeros-mcp failed: ${message}`);
  process.exit(1);
});
