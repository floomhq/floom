import { chmodSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { floomConfigDir } from "./credentials.js";

type TelemetryIdentityFile = {
  anonymous_distinct_id?: string;
};

function truthyEnv(value: string | undefined): boolean {
  const normalized = (value || "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function telemetryDisabled(): boolean {
  return (
    truthyEnv(process.env.DO_NOT_TRACK) ||
    truthyEnv(process.env.FLOOM_CLI_TELEMETRY_DISABLED) ||
    truthyEnv(process.env.WORKEROS_CLI_TELEMETRY_DISABLED)
  );
}

export function telemetryRequestHeaders(source: "cli" | "mcp"): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Floom-Source": source,
  };
  if (telemetryDisabled()) {
    headers["X-Floom-Do-Not-Track"] = "1";
  }
  return headers;
}

function telemetryIdentityPath(): string {
  return join(floomConfigDir(), "telemetry.json");
}

export async function getAnonymousDistinctId(): Promise<string> {
  const path = telemetryIdentityPath();
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as TelemetryIdentityFile;
    if (typeof parsed.anonymous_distinct_id === "string" && parsed.anonymous_distinct_id.trim()) {
      return parsed.anonymous_distinct_id.trim();
    }
  } catch {
    // Missing or unreadable identity files fall through to a fresh stable id.
  }

  // Distinct ID strategy: one random, non-PII id per install, shared by CLI and
  // MCP via the config dir; login later links it to the authenticated user.
  const anonymousDistinctId = `anon_${randomUUID()}`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify({ anonymous_distinct_id: anonymousDistinctId }, null, 2)}\n`, "utf8");
  chmodSync(path, 0o600);
  return anonymousDistinctId;
}
