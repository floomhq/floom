import { createHash } from "node:crypto";
import { homedir, hostname } from "node:os";

export type TelemetryProperties = Record<string, unknown>;

const DEFAULT_POSTHOG_HOST = "https://us.posthog.com";
const TELEMETRY_TIMEOUT_MS = 1000;

let anonymousDistinctId: string | undefined;

function telemetryKey(): string | undefined {
  return process.env.POSTHOG_KEY?.trim() || process.env.NEXT_PUBLIC_POSTHOG_KEY?.trim() || undefined;
}

function telemetryHost(): string {
  return (process.env.POSTHOG_HOST?.trim() || DEFAULT_POSTHOG_HOST).replace(/\/+$/, "");
}

function telemetryOptedOut(): boolean {
  const value = (process.env.DO_NOT_TRACK || "").trim().toLowerCase();
  return value === "1" || value === "true";
}

function stableAnonymousId(): string {
  if (!anonymousDistinctId) {
    const hash = createHash("sha256")
      .update(`${hostname()}:${homedir()}`)
      .digest("hex")
      .slice(0, 24);
    anonymousDistinctId = `mcp_anon_${hash}`;
  }
  return anonymousDistinctId;
}

export async function captureTelemetry(
  event: string,
  properties: TelemetryProperties,
  context: { workspaceId?: string } = {},
): Promise<void> {
  try {
    if (telemetryOptedOut()) {
      return;
    }
    const apiKey = telemetryKey();
    if (!apiKey) {
      return;
    }

    const workspaceId = context.workspaceId?.trim() || undefined;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TELEMETRY_TIMEOUT_MS);
    try {
      await fetch(`${telemetryHost()}/capture/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          api_key: apiKey,
          event,
          distinct_id: workspaceId || stableAnonymousId(),
          properties: {
            ...properties,
            ...(workspaceId ? { workspace_id: workspaceId, $groups: { workspace: workspaceId } } : {}),
          },
          timestamp: new Date().toISOString(),
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    // Telemetry is best-effort and must never affect MCP tool execution.
  }
}
