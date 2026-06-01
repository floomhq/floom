#!/usr/bin/env node
import { Buffer } from "node:buffer";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const DEFAULT_API_BASE = "https://workers-api.floom.dev";
const TERMINAL_RUN_STATUSES = new Set([
  "success",
  "error",
  "completed",
  "failed",
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

function isCloudApi(): boolean {
  return /workeros-api\.floom\.dev/i.test(apiBase()) || Boolean(process.env.WORKEROS_API_TOKEN);
}

function resolvePath(path: string): string {
  if (!isCloudApi()) return path;
  if (path.startsWith("/api/")) return path;
  if (path.startsWith("/auth/")) return path;
  if (path === "/healthz") return path;
  return `/api${path.startsWith("/") ? "" : "/"}${path}`;
}

function authHeader(): Record<string, string> {
  const token = process.env.WORKEROS_API_TOKEN?.trim();
  if (token) {
    return { "x-floom-token": token };
  }
  const secret = process.env.WORKEROS_API_SECRET?.trim();
  if (!secret) {
    throw new Error("WORKEROS_API_TOKEN or WORKEROS_API_SECRET is required");
  }
  return { "x-floom-secret": secret };
}

function jsonResult(data: unknown, summary?: string): CallToolResult {
  const safeData = redactSecrets(data);
  const structuredContent =
    data && typeof data === "object" && !Array.isArray(data) ? (data as JsonObject) : { data };
  return {
    content: [
      {
        type: "text",
        text: summary ? `${summary}\n${JSON.stringify(safeData, null, 2)}` : JSON.stringify(safeData, null, 2),
      },
    ],
    structuredContent,
  };
}

function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const redacted: JsonObject = {};
  for (const [key, nested] of Object.entries(value as JsonObject)) {
    if (/(secret|token|password|api[_-]?key)/i.test(key)) {
      redacted[key] = "[redacted]";
    } else {
      redacted[key] = redactSecrets(nested);
    }
  }
  return redacted;
}

function errorResult(error: unknown): CallToolResult {
  const message = redactSecretText(error instanceof Error ? error.message : String(error));
  const status = error instanceof WorkerosApiError ? error.status : undefined;
  const body = error instanceof WorkerosApiError ? redactSecrets(error.body) : undefined;
  const structuredContent: JsonObject = { error: message };
  if (status !== undefined) {
    structuredContent.status = status;
  }
  if (body !== undefined) {
    structuredContent.body = body;
  }
  return {
    isError: true,
    content: [{ type: "text", text: message }],
    structuredContent,
  };
}

function redactSecretText(text: string): string {
  return text.replace(
    /((?:secret|token|password|api[_-]?key)["']?\s*[:=]\s*["']?)([^"',}\s]+)/gi,
    "$1[redacted]",
  );
}

async function callTool(handler: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await handler();
  } catch (error) {
    return errorResult(error);
  }
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
  const url = new URL(`${apiBase()}${resolvePath(path)}`);
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
      ...authHeader(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const parsed = await parseResponse(response);
  if (!response.ok) {
    const safeParsed = redactSecrets(parsed);
    const detail =
      typeof safeParsed === "object" && safeParsed && "detail" in safeParsed
        ? redactSecretText(String((safeParsed as { detail: unknown }).detail))
        : JSON.stringify(safeParsed);
    throw new WorkerosApiError(
      `Workeros API ${method} ${path} failed with HTTP ${response.status}: ${detail}`,
      response.status,
      parsed,
    );
  }
  return parsed;
}

async function requestBytes(
  method: string,
  path: string,
  body: Uint8Array,
  contentType = "application/octet-stream",
): Promise<unknown> {
  const response = await fetch(buildUrl(path), {
    method,
    headers: {
      "accept": "application/json",
      "content-type": contentType,
      ...authHeader(),
    },
    body: Buffer.from(body),
  });

  const parsed = await parseResponse(response);
  if (!response.ok) {
    const safeParsed = redactSecrets(parsed);
    const detail =
      typeof safeParsed === "object" && safeParsed && "detail" in safeParsed
        ? redactSecretText(String((safeParsed as { detail: unknown }).detail))
        : JSON.stringify(safeParsed);
    throw new WorkerosApiError(
      `Workeros API ${method} ${path} failed with HTTP ${response.status}: ${detail}`,
      response.status,
      parsed,
    );
  }
  return parsed;
}

async function readContextFile(name: string, path: string): Promise<unknown> {
  const detail = await request("GET", `/contexts/${encodeURIComponent(name)}`) as JsonObject;
  const files = Array.isArray(detail.files) ? detail.files as JsonObject[] : [];
  const file = files.find((item) => item.path === path);
  if (!file) {
    throw new WorkerosApiError(`Context file ${name}/${path} was not found`, 404);
  }
  const downloadPath = `/contexts/${encodeURIComponent(name)}/files/${path.split("/").map(encodeURIComponent).join("/")}`;
  if (file.is_binary) {
    return {
      name,
      path,
      size: file.size,
      mime_type: file.mime_type,
      is_binary: true,
      download_url: buildUrl(downloadPath),
      note: "Binary context file. Use the HTTP API download URL to fetch bytes.",
    };
  }

  const response = await fetch(buildUrl(downloadPath), {
    method: "GET",
    headers: {
      "accept": "text/plain, application/json, text/*",
      ...authHeader(),
    },
  });
  if (!response.ok) {
    const parsed = await parseResponse(response);
    throw new WorkerosApiError(
      `Workeros API GET ${downloadPath} failed with HTTP ${response.status}: ${JSON.stringify(redactSecrets(parsed))}`,
      response.status,
      parsed,
    );
  }
  return {
    name,
    path,
    size: file.size,
    mime_type: file.mime_type,
    is_binary: false,
    content: await response.text(),
  };
}

async function listTriggers(workerId?: string, app?: string): Promise<unknown> {
  if (app) {
    return request("GET", "/integrations/triggers", undefined, { app });
  }
  if (!workerId) {
    return request("GET", "/integrations/triggers");
  }
  const worker = await request("GET", `/workers/${encodeURIComponent(workerId)}`) as JsonObject;
  const config = (worker.config && typeof worker.config === "object") ? worker.config as JsonObject : {};
  const connections = Array.isArray(config.connections)
    ? config.connections.flatMap((item) => {
        if (typeof item === "string") return [item];
        if (item && typeof item === "object") {
          const record = item as JsonObject;
          const composio = record.composio;
          if (composio && typeof composio === "object" && typeof (composio as JsonObject).app === "string") {
            return [String((composio as JsonObject).app)];
          }
          if (typeof record.app === "string") return [String(record.app)];
        }
        return [];
      })
    : [];
  if (!connections.length) {
    return { items: [] };
  }
  const merged: JsonObject[] = [];
  const seen = new Set<string>();
  for (const connection of connections) {
    const payload = await request("GET", "/integrations/triggers", undefined, { app: connection }) as JsonObject;
    const items = Array.isArray(payload.items) ? payload.items : [];
    for (const item of items) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const eventName = String((item as JsonObject).name || (item as JsonObject).slug || JSON.stringify(item));
      const dedupeKey = `${connection}:${eventName}`;
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);
      merged.push(item as JsonObject);
    }
  }
  return { items: merged };
}

async function watchRunEvents(runId: string, timeoutMs: number): Promise<JsonObject> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const events: JsonObject[] = [];
  let status: string | undefined;
  let buffer = "";
  let sawTerminalStatus = false;

  try {
    const response = await fetch(buildUrl(`/runs/${encodeURIComponent(runId)}/events`), {
      method: "GET",
      headers: {
        "accept": "text/event-stream",
        ...authHeader(),
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      const parsed = await parseResponse(response);
      const safeParsed = redactSecrets(parsed);
      const detail =
        typeof safeParsed === "object" && safeParsed && "detail" in safeParsed
          ? redactSecretText(String((safeParsed as { detail: unknown }).detail))
          : JSON.stringify(safeParsed);
      throw new WorkerosApiError(
        `Workeros API GET /runs/${runId}/events failed with HTTP ${response.status}: ${detail}`,
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
          sawTerminalStatus = true;
        }
        if (event.type === "close" || (event.data && typeof event.data === "object" && (event.data as JsonObject).type === "close")) {
          await reader.cancel();
          return { run_id: runId, status: status || "closed", events };
        }
      }
      if (sawTerminalStatus && events.length > 0 && buffer === "") {
        await reader.cancel();
        return { run_id: runId, status, events };
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

function extractEnvSecrets(runPy: string): string[] {
  const secrets = new Set<string>();
  const patterns = [
    /\bos\.environ\s*\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]/g,
    /\bos\.environ\.get\s*\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g,
    /\bos\.getenv\s*\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of runPy.matchAll(pattern)) {
      secrets.add(match[1]);
    }
  }
  return [...secrets].sort();
}

function extractConnections(workerYml: string): string[] {
  const connections = new Set<string>();
  const inline = workerYml.match(/^connections:\s*\[([^\]]*)\]\s*$/m);
  if (inline) {
    for (const item of inline[1].split(",")) {
      const value = item.trim().replace(/^["']|["']$/g, "");
      if (value) {
        connections.add(value);
      }
    }
  }

  const lines = workerYml.split(/\r?\n/);
  const start = lines.findIndex((line) => /^connections:\s*$/.test(line));
  if (start !== -1) {
    for (let index = start + 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (/^\S/.test(line) && line.trim()) {
        break;
      }
      const match = line.match(/^\s*-\s*([^#\s]+|"[^"]+"|'[^']+')/);
      if (match) {
        connections.add(match[1].trim().replace(/^["']|["']$/g, ""));
      }
    }
  }

  return [...connections].sort();
}

function hasCapabilityList(workerYml: string, key: "secrets" | "connections"): boolean {
  const lines = workerYml.split(/\r?\n/);
  const start = lines.findIndex((line) => /^capabilities:\s*(?:#.*)?$/.test(line));
  if (start === -1) {
    return false;
  }
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\S/.test(line) && line.trim()) {
      break;
    }
    if (new RegExp(`^\\s{2}${key}:`).test(line)) {
      return true;
    }
  }
  return false;
}

function capabilityBlock(key: "secrets" | "connections", values: string[]): string[] {
  return [`  ${key}:`, ...values.map((value) => `    - ${value}`)];
}

function addCapabilityList(workerYml: string, key: "secrets" | "connections", values: string[]): string {
  if (values.length === 0 || hasCapabilityList(workerYml, key)) {
    return workerYml;
  }

  const lines = workerYml.split(/\r?\n/);
  const capsIndex = lines.findIndex((line) => /^capabilities:\s*(?:#.*)?$/.test(line));
  if (capsIndex === -1) {
    const suffix = workerYml.endsWith("\n") ? "" : "\n";
    return `${workerYml}${suffix}capabilities:\n${capabilityBlock(key, values).join("\n")}\n`;
  }

  lines.splice(capsIndex + 1, 0, ...capabilityBlock(key, values));
  return lines.join("\n");
}

function autoFillCapabilities(workerYml: string, runPy: string): string {
  let updated = workerYml;
  updated = addCapabilityList(updated, "secrets", extractEnvSecrets(runPy));
  updated = addCapabilityList(updated, "connections", extractConnections(workerYml));
  return updated;
}

const workerIdSchema = z.object({
  id: z.string().min(1).describe("Workeros worker id."),
});

const runIdSchema = z.object({
  id: z.string().min(1).describe("Workeros run id."),
});

async function consumeChatStream(
  message: string,
  conversationId: string | undefined,
  timeoutMs: number,
): Promise<JsonObject> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const textParts: string[] = [];
  const toolCalls: JsonObject[] = [];
  let finishEvent: JsonObject | null = null;
  let buffer = "";

  try {
    const body: JsonObject = { message };
    if (conversationId) {
      body.conversation_id = conversationId;
    }
    const response = await fetch(buildUrl("/chat"), {
      method: "POST",
      headers: {
        "accept": "text/event-stream",
        "content-type": "application/json",
        ...authHeader(),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const parsed = await parseResponse(response);
      const safeParsed = redactSecrets(parsed);
      const detail =
        typeof safeParsed === "object" && safeParsed && "detail" in safeParsed
          ? redactSecretText(String((safeParsed as { detail: unknown }).detail))
          : JSON.stringify(safeParsed);
      throw new WorkerosApiError(
        `POST /chat failed with HTTP ${response.status}: ${detail}`,
        response.status,
        parsed,
      );
    }
    if (!response.body) {
      throw new WorkerosApiError("POST /chat response has no body");
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
        if (!chunk || chunk.startsWith(":")) {
          continue;
        }
        const dataLine = chunk.split(/\r?\n/).find((l) => l.startsWith("data:"));
        if (!dataLine) {
          continue;
        }
        const raw = dataLine.slice(5).trimStart();
        let part: JsonObject;
        try {
          part = JSON.parse(raw);
        } catch {
          continue;
        }
        const partType = part.type as string | undefined;
        if (partType === "text") {
          textParts.push(String(part.text || ""));
        } else if (partType === "tool-call") {
          toolCalls.push(part);
        } else if (partType === "finish") {
          finishEvent = part;
          await reader.cancel();
          return buildChatResult(textParts, toolCalls, finishEvent);
        }
      }
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new WorkerosApiError(`workspace.chat timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  return buildChatResult(textParts, toolCalls, finishEvent);
}

function buildChatResult(
  textParts: string[],
  toolCalls: JsonObject[],
  finishEvent: JsonObject | null,
): JsonObject {
  return {
    reply: textParts.join(""),
    tool_calls: toolCalls,
    conversation_id: finishEvent?.conversation_id ?? null,
    message_id: finishEvent?.message_id ?? null,
  };
}

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
    async () => callTool(async () => jsonResult(await request("GET", "/workers"))),
  );

  server.registerTool(
    "workers.get",
    {
      title: "Get Worker",
      description: "Get a Workeros worker by id.",
      inputSchema: workerIdSchema.shape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ id }) => callTool(async () => jsonResult(await request("GET", `/workers/${encodeURIComponent(id)}`))),
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
      callTool(async () =>
        jsonResult(
          await request("POST", "/workers", { worker_yml: autoFillCapabilities(worker_yml, run_py), run_py }),
          "Worker created.",
        ),
      ),
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
        webhook_secret_rotate: z.boolean().optional().describe("Rotate the worker webhook secret and return the new raw secret once."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ id, ...updates }) =>
      callTool(async () =>
        jsonResult(await request("PATCH", `/workers/${encodeURIComponent(id)}`, updates), "Worker updated."),
      ),
  );

  server.registerTool(
    "workers.delete",
    {
      title: "Delete Worker",
      description: "Delete a Workeros worker.",
      inputSchema: workerIdSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ id }) =>
      callTool(async () => jsonResult(await request("DELETE", `/workers/${encodeURIComponent(id)}`), "Worker deleted.")),
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
      callTool(async () =>
        jsonResult(
          await request("POST", `/workers/${encodeURIComponent(id)}/runs`, { inputs, trigger_source }),
          "Worker run started.",
        ),
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
      callTool(async () => jsonResult(await request("GET", "/runs", undefined, { worker_id, status, limit, offset }))),
  );

  server.registerTool(
    "runs.get",
    {
      title: "Get Run",
      description: "Get a Workeros run by id, including logs, outputs, artifacts, and approval status.",
      inputSchema: runIdSchema.shape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ id }) => callTool(async () => jsonResult(await request("GET", `/runs/${encodeURIComponent(id)}`))),
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
    async ({ id, timeout_ms }) =>
      callTool(async () => jsonResult(await watchRunEvents(id, timeout_ms), "Run watch completed.")),
  );

  server.registerTool(
    "secrets.list",
    {
      title: "List Secrets",
      description: "List configured secret names and status.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => callTool(async () => jsonResult(await request("GET", "/secrets"))),
  );

  server.registerTool(
    "secrets.set",
    {
      title: "Set Secret",
      description: "Create or update a secret value.",
      inputSchema: {
        key: z.string().min(1).describe("Secret name."),
        value: z.string().min(1).describe("Secret value."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ key, value }) =>
      callTool(async () =>
        jsonResult(await request("POST", `/secrets/${encodeURIComponent(key)}`, { value }), "Secret saved."),
      ),
  );

  server.registerTool(
    "secrets.delete",
    {
      title: "Delete Secret",
      description: "Delete a secret by key.",
      inputSchema: {
        key: z.string().min(1).describe("Secret name."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ key }) =>
      callTool(async () =>
        jsonResult(await request("DELETE", `/secrets/${encodeURIComponent(key)}`), "Secret deleted."),
      ),
  );

  server.registerTool(
    "connections.list",
    {
      title: "List Connections",
      description: "List configured app connections.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => callTool(async () => jsonResult(await request("GET", "/connections"))),
  );

  server.registerTool(
    "connections.add_mcp",
    {
      title: "Add MCP Connection",
      description: "Save an MCP server connection. Supports streamable_http, sse, and stdio transports.",
      inputSchema: {
        label: z.string().min(1).describe("Stable MCP label."),
        transport: z.enum(["streamable_http", "sse", "stdio"]).default("streamable_http"),
        url: z.string().optional().describe("HTTP/SSE endpoint URL."),
        command: z.string().optional().describe("Stdio command, for example npx."),
        args: z.array(z.string()).optional().default([]).describe("Stdio command arguments."),
        env: z.record(z.string(), z.string()).optional().default({}).describe("Stdio env map. Use secret:SECRET_NAME values for secrets."),
        cwd: z.string().optional().describe("Optional stdio working directory."),
        auth_secret: z.string().optional().describe("Secret name for HTTP/SSE bearer auth."),
        allowed_tools: z.array(z.string()).optional().default([]).describe("Optional allowed tool names."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (payload) =>
      callTool(async () => jsonResult(await request("POST", "/connections/mcp", payload), "MCP connection saved.")),
  );

  server.registerTool(
    "contexts.list",
    {
      title: "List Contexts",
      description: "List Workeros context folders.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => callTool(async () => jsonResult(await request("GET", "/contexts"))),
  );

  server.registerTool(
    "contexts.read",
    {
      title: "Read Context File",
      description: "Read a UTF-8 context file, or return metadata and a download URL for binary files.",
      inputSchema: {
        name: z.string().min(1).describe("Context name."),
        path: z.string().min(1).describe("File path inside the context."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ name, path }) =>
      callTool(async () => jsonResult(await readContextFile(name, path))),
  );

  server.registerTool(
    "contexts.write",
    {
      title: "Write Context File",
      description: "Create or update a UTF-8 text file inside a context.",
      inputSchema: {
        name: z.string().min(1).describe("Context name."),
        path: z.string().min(1).describe("File path inside the context."),
        content: z.string().describe("UTF-8 text content."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ name, path, content }) =>
      callTool(async () =>
        jsonResult(
          await request(
            "PUT",
            `/contexts/${encodeURIComponent(name)}/files/${path.split("/").map(encodeURIComponent).join("/")}`,
            { content },
          ),
          "Context file saved.",
        ),
      ),
  );

  server.registerTool(
    "contexts.upload",
    {
      title: "Upload Context File",
      description: "Create or update a binary file inside a context from base64 bytes.",
      inputSchema: {
        name: z.string().min(1).describe("Context name."),
        path: z.string().min(1).describe("File path inside the context."),
        base64_bytes: z.string().min(1).describe("Base64-encoded file bytes."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ name, path, base64_bytes }) =>
      callTool(async () => {
        const bytes = Buffer.from(base64_bytes, "base64");
        return jsonResult(
          await requestBytes(
            "PUT",
            `/contexts/${encodeURIComponent(name)}/files/${path.split("/").map(encodeURIComponent).join("/")}`,
            bytes,
          ),
          "Context file uploaded.",
        );
      }),
  );

  server.registerTool(
    "triggers.list",
    {
      title: "List Triggers",
      description: "List integration triggers, globally or filtered by worker/app.",
      inputSchema: {
        worker_id: z.string().optional().describe("Optional worker id to scope triggers by worker connections."),
        app: z.string().optional().describe("Optional app slug filter."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ worker_id, app }) =>
      callTool(async () => jsonResult(await listTriggers(worker_id, app))),
  );

  server.registerTool(
    "workspace.chat",
    {
      title: "Chat with Workspace Agent",
      description:
        "Send a message to the Workeros workspace agent and receive a streamed reply. " +
        "The agent can list workers, inspect runs, create workers, manage secrets, and more. " +
        "Supply conversation_id to continue an existing conversation (enables anaphor resolution).",
      inputSchema: {
        message: z.string().min(1).describe("The message to send to the workspace agent."),
        conversation_id: z.string().optional().describe("Optional conversation ID to continue a previous session."),
        timeout_ms: z.number().optional().default(120000).describe("Maximum wait time in milliseconds."),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ message, conversation_id, timeout_ms = 120000 }) =>
      callTool(async () => {
        const parts = await consumeChatStream(message, conversation_id, timeout_ms);
        return jsonResult(parts);
      }),
  );

  return server;
}

export async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const executedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (executedPath && fileURLToPath(import.meta.url) === executedPath) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`workeros-mcp failed: ${message}`);
    process.exit(1);
  });
}
