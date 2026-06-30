import { FloomApiClient } from "./api.js";
import { readCredentials, type StoredCredentials } from "./credentials.js";
import { getAnonymousDistinctId, telemetryDisabled } from "./telemetry-config.js";

export type CliTelemetryPayload = {
  command: string;
  success: boolean;
  duration_ms: number;
  exit_code: number;
  worker_id?: string;
  run_id?: string;
};

export type McpTelemetryPayload = {
  tool_name: string;
  success: boolean;
  duration_ms: number;
  auth_method?: string;
  worker_id?: string;
  run_id?: string;
  status_code?: number;
  error_category?: string;
  is_custom_tool?: boolean;
};

export function apiBaseKind(apiBase: string): "local" | "cloud" | "custom" {
  let host = "";
  try {
    host = new URL(apiBase).hostname.toLowerCase();
  } catch {
    return "custom";
  }
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    return "local";
  }
  if (
    host.endsWith("floom.dev") ||
    host.endsWith("floom.ai") ||
    host.endsWith("floom.app") ||
    host.endsWith("workeros.com")
  ) {
    return "cloud";
  }
  return "custom";
}

async function telemetryClient(): Promise<{ client: FloomApiClient; credentials: StoredCredentials } | null> {
  if (telemetryDisabled()) return null;
  try {
    const credentials = await readCredentials();
    if (!credentials) return null;
    return { client: new FloomApiClient(credentials.api_base, credentials), credentials };
  } catch {
    return null;
  }
}

export async function emitCliCommandTelemetry(payload: CliTelemetryPayload): Promise<void> {
  try {
    const resolved = await telemetryClient();
    if (!resolved) return;
    const anonymousDistinctId = await getAnonymousDistinctId();
    await resolved.client.requestJson("POST", "/telemetry/cli-command", {
      body: {
        anonymous_distinct_id: anonymousDistinctId,
        command: payload.command,
        success: payload.success,
        duration_ms: Math.max(0, Math.floor(payload.duration_ms)),
        exit_code: payload.exit_code,
        api_base_kind: apiBaseKind(resolved.credentials.api_base),
        worker_id: payload.worker_id,
        run_id: payload.run_id,
      },
    });
  } catch {
    // Analytics must never affect CLI behavior.
  }
}

export async function emitMcpToolTelemetry(payload: McpTelemetryPayload): Promise<void> {
  try {
    const resolved = await telemetryClient();
    if (!resolved) return;
    const anonymousDistinctId = await getAnonymousDistinctId();
    await resolved.client.requestJson("POST", "/telemetry/mcp-tool", {
      body: {
        anonymous_distinct_id: anonymousDistinctId,
        tool_name: payload.tool_name,
        success: payload.success,
        duration_ms: Math.max(0, Math.floor(payload.duration_ms)),
        auth_method: payload.auth_method,
        worker_id: payload.worker_id,
        run_id: payload.run_id,
        status_code: payload.status_code,
        error_category: payload.error_category,
        is_custom_tool: payload.is_custom_tool || false,
      },
    });
  } catch {
    // Analytics must never affect MCP tool behavior.
  }
}

export async function identifyTelemetryUser(credentials: StoredCredentials): Promise<void> {
  if (telemetryDisabled()) return;
  try {
    const anonymousDistinctId = await getAnonymousDistinctId();
    const client = new FloomApiClient(credentials.api_base, credentials);
    await client.requestJson("POST", "/telemetry/identify", {
      body: { anonymous_distinct_id: anonymousDistinctId },
    });
  } catch {
    // Analytics must never affect auth/login behavior.
  }
}
