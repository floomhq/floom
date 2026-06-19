import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WorkerosApiClient, WorkerosApiError } from "../lib/api.js";
import { readCredentials } from "../lib/credentials.js";
import { log, printJson } from "../lib/output.js";

type Check = {
  name: string;
  ok: boolean;
  detail?: string;
  hint?: string;
};

function pass(name: string, detail?: string): Check {
  return { name, ok: true, detail };
}
function fail(name: string, detail?: string, hint?: string): Check {
  return { name, ok: false, detail, hint };
}
function warn(name: string, detail?: string, hint?: string): Check {
  return { name, ok: true, detail, hint };
}

const API_DEFAULT = "https://localhost:8000";

async function checkApiReachable(apiBase: string): Promise<Check> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(`${apiBase}/health`, {
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));
    if (response.ok) {
      const body = await response.json().catch(() => ({})) as Record<string, unknown>;
      const version = typeof body.version === "string" ? body.version : "ok";
      return pass("api_url", `${apiBase} — ${version}`);
    }
    return fail("api_url", `HTTP ${response.status}`, "Check API status: https://github.com/floomhq/workeros/issues");
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      return fail("api_url", `Timeout reaching ${apiBase}`, "Check your network or API status");
    }
    return fail("api_url", String(error), "Check your network connection or API status");
  }
}

async function checkAuth(client: WorkerosApiClient): Promise<Check> {
  try {
    await client.requestJson("GET", "/system/info");
    return pass("auth", "Token valid");
  } catch (error) {
    if (error instanceof WorkerosApiError && (error.status === 401 || error.status === 403)) {
      return fail("auth", "Token rejected by API", "Re-run: floom login");
    }
    if (error instanceof WorkerosApiError && error.status) {
      return fail("auth", `HTTP ${error.status}`, "Re-run: floom login");
    }
    return fail("auth", "Could not reach API to validate token", "Re-run: floom login");
  }
}

function resolveHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || "";
}

function checkMcpInstall(): Check {
  const home = resolveHomeDir();
  if (!home) {
    return fail("mcp_install", "HOME not set", "Set HOME environment variable");
  }

  const candidates = [
    { label: "Claude Code", path: join(home, ".claude", "settings.json") },
    { label: "Cursor", path: join(home, ".cursor", "mcp.json") },
    { label: "Continue", path: join(home, ".continue", ".continuerc.json") },
    { label: "Codex", path: join(home, ".codex", "config.json") },
    { label: "external audit", path: join(home, ".external-audit", "mcp.json") },
  ];

  const found: string[] = [];
  for (const candidate of candidates) {
    if (!existsSync(candidate.path)) continue;
    try {
      const raw = readFileSync(candidate.path, "utf8");
      const config = JSON.parse(raw) as Record<string, unknown>;
      const servers = config.mcpServers as Record<string, unknown> | undefined;
      if (servers && "workeros" in servers) {
        found.push(candidate.label);
      }
    } catch {
      // Unreadable config — skip
    }
  }

  if (found.length > 0) {
    return pass("mcp_install", `Found in: ${found.join(", ")}`);
  }
  return warn("mcp_install", "Not found in any editor config", "Install: floom mcp install");
}

async function checkRecentRuns(client: WorkerosApiClient): Promise<Check> {
  try {
    await client.requestJson("GET", "/runs", { query: { limit: 1 } });
    return pass("recent_runs", "API + auth + DB reachable");
  } catch (error) {
    if (error instanceof WorkerosApiError && (error.status === 401 || error.status === 403)) {
      return fail("recent_runs", "Auth rejected", "Re-run: floom login");
    }
    if (error instanceof WorkerosApiError && error.status) {
      return fail("recent_runs", `HTTP ${error.status}`, "Check API status: https://github.com/floomhq/workeros/issues");
    }
    return fail("recent_runs", "Could not reach /runs endpoint", "Check your network connection");
  }
}

export async function doctorCommand(options: { json?: boolean } = {}): Promise<number> {
  const credentials = await readCredentials();
  const apiBase = credentials?.api_base || process.env.WORKEROS_API_BASE || API_DEFAULT;
  const client = credentials ? new WorkerosApiClient(apiBase, credentials) : null;

  const checks: Check[] = [];

  // Check 1: API reachable
  checks.push(await checkApiReachable(apiBase));

  // Check 2: Auth valid
  if (!client) {
    checks.push(fail("auth", "No credentials found", "Run: floom login"));
  } else {
    checks.push(await checkAuth(client));
  }

  // Check 3: MCP install
  checks.push(checkMcpInstall());

  // Check 4: Recent runs endpoint
  if (client) {
    checks.push(await checkRecentRuns(client));
  } else {
    checks.push(fail("recent_runs", "Skipped — not authenticated", "Run: floom login"));
  }

  if (options.json) {
    printJson({ ok: checks.every((c) => c.ok), checks });
    return checks.every((c) => c.ok) ? 0 : 1;
  }

  log.heading("Floom doctor");

  for (const check of checks) {
    const detail = check.detail ? ` — ${check.detail}` : "";
    if (!check.ok) {
      log.err(`${check.name}${detail}`);
      if (check.hint) log.info(`  ${check.hint}`);
    } else if (check.hint) {
      // warn-level (ok but with hint)
      log.warn(`${check.name}${detail}`);
      log.info(`  ${check.hint}`);
    } else {
      log.ok(`${check.name}${detail}`);
    }
  }

  log.blank();
  const failed = checks.filter((c) => !c.ok).length;
  if (failed === 0) {
    log.ok("All checks passed.");
  } else {
    log.err(`${failed} check${failed === 1 ? "" : "s"} failed; see hints above.`);
  }

  return failed === 0 ? 0 : 1;
}
