import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { createAuthenticatedClient, WorkerosApiError, WorkerosConnectionError } from "../lib/api.js";
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

type WorkerSource = {
  dir: string;
  workerYml: string;
  runPy?: string;
  skillMd?: string;
  workerId: string;
  displayName: string;
  runtime: string;
  entrypoint?: string;
};

type WorkerSourcePayload = {
  worker_yml: string;
  run_py: string;
  skill_md?: string;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNestedRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = parent[key];
  return isRecord(value) ? value : undefined;
}

function readRuntime(manifest: Record<string, unknown>): string | undefined {
  const runtime = manifest.runtime;
  if (typeof runtime === "string") return nonEmptyString(runtime);
  if (isRecord(runtime)) return nonEmptyString(runtime.type) || nonEmptyString(runtime.name);

  const exec = readNestedRecord(manifest, "exec");
  if (!exec) return undefined;
  const execRuntime = exec.runtime;
  if (typeof execRuntime === "string") return nonEmptyString(execRuntime);
  if (isRecord(execRuntime)) return nonEmptyString(execRuntime.type) || nonEmptyString(execRuntime.name);
  return undefined;
}

function readEntrypoint(manifest: Record<string, unknown>): string | undefined {
  const exec = readNestedRecord(manifest, "exec");
  const execEntry = exec ? nonEmptyString(exec.entry) : undefined;
  if (execEntry) return execEntry;
  const runtime = readNestedRecord(manifest, "runtime");
  const runtimeEntrypoint = runtime ? nonEmptyString(runtime.entrypoint) : undefined;
  if (runtimeEntrypoint) return runtimeEntrypoint;
  return nonEmptyString(manifest.entrypoint);
}

function declaredComposioConnections(manifest: Record<string, unknown>): Map<string, Set<string> | null> {
  const result = new Map<string, Set<string> | null>();
  const raw = manifest.connections;
  if (!Array.isArray(raw)) return result;
  for (const item of raw) {
    let app: string | undefined;
    let allowedTools: string[] | undefined;
    if (typeof item === "string") {
      app = item;
    } else if (isRecord(item)) {
      if (typeof item.app === "string") {
        app = item.app;
        allowedTools = Array.isArray(item.allowed_tools)
          ? item.allowed_tools.filter((tool): tool is string => typeof tool === "string")
          : undefined;
      } else if (isRecord(item.composio) && typeof item.composio.app === "string") {
        app = item.composio.app;
        allowedTools = Array.isArray(item.composio.allowed_tools)
          ? item.composio.allowed_tools.filter((tool): tool is string => typeof tool === "string")
          : undefined;
      }
    }
    const normalizedApp = app?.trim().toLowerCase();
    if (!normalizedApp) continue;
    if (!allowedTools || allowedTools.length === 0) {
      result.set(normalizedApp, null);
      continue;
    }
    const normalizedTools = new Set(allowedTools.map((tool) => tool.trim().toUpperCase()).filter(Boolean));
    const existing = result.get(normalizedApp);
    if (existing === null) continue;
    if (!existing) {
      result.set(normalizedApp, normalizedTools);
    } else {
      for (const tool of normalizedTools) existing.add(tool);
    }
  }
  return result;
}

function declaredSecrets(manifest: Record<string, unknown>): Set<string> {
  const result = new Set<string>();
  const collect = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (typeof item === "string" && item.trim()) {
        result.add(item.trim().toUpperCase());
      }
    }
  };
  collect(manifest.secrets);
  const capabilities = readNestedRecord(manifest, "capabilities");
  if (capabilities) {
    collect(capabilities.secrets);
  }
  const exec = readNestedRecord(manifest, "exec");
  if (exec) {
    collect(exec.secrets);
  }
  return result;
}

function toolApp(toolSlug: string, declaredApps: Iterable<string>): string {
  const normalized = toolSlug.toUpperCase();
  const matches = [...declaredApps].filter((app) =>
    normalized.startsWith(`${app.toUpperCase().replaceAll("-", "_")}_`),
  );
  if (matches.length === 0) return "";
  return matches.sort((a, b) => b.length - a.length)[0];
}

function validateNativeRuntimeContract(
  manifest: Record<string, unknown>,
  runPy: string | undefined,
): string[] {
  if (!runPy?.trim()) return [];
  const errors: string[] = [];
  const declared = declaredComposioConnections(manifest);
  const secrets = declaredSecrets(manifest);
  const usesComposioCli =
    /subprocess\.(?:run|Popen|call|check_call|check_output)\s*\(/.test(runPy) &&
    /["']composio["']/.test(runPy) &&
    /["']execute["']/.test(runPy);
  if (usesComposioCli) {
    errors.push(
      "run.py shells out to `composio execute`; E2B workers must call the Workeros proxy at /runs/{FLOOM_RUN_ID}/composio-execute/{TOOL_SLUG}",
    );
  }

  const usesProxy = /composio-execute\/[A-Z0-9_]+/.test(runPy);
  const readsConnections = /connections\.json/.test(runPy);
  if ((usesProxy || readsConnections) && declared.size === 0) {
    errors.push("run.py uses Composio/connections.json but worker.yml has no `connections:` declaration");
  }

  const toolSlugs = new Set<string>();
  for (const match of runPy.matchAll(/composio-execute\/([A-Z0-9_]+)/g)) {
    toolSlugs.add(match[1].toUpperCase());
  }
  for (const match of runPy.matchAll(/["']([A-Z][A-Z0-9]+_[A-Z0-9_]+)["']/g)) {
    const candidate = match[1].toUpperCase();
    if (["FLOOM_RUN_ID", "FLOOM_TRACE_ID", "WORKEROS_API_URL", "WORKEROS_API_BASE"].includes(candidate)) {
      continue;
    }
    if (secrets.has(candidate)) {
      continue;
    }
    toolSlugs.add(candidate);
  }
  for (const slug of toolSlugs) {
    const app = toolApp(slug, declared.keys());
    if (!app || !declared.has(app)) {
      errors.push(`run.py references ${slug}, but worker.yml does not declare connection '${app || "unknown"}'`);
      continue;
    }
    const allowed = declared.get(app);
    if (allowed !== null && allowed && !allowed.has(slug)) {
      errors.push(`run.py references ${slug}, but ${app}.allowed_tools does not include it`);
    }
  }

  if (/FLOOM_RUN_ID/.test(runPy) && !/WORKEROS_API_URL/.test(runPy)) {
    errors.push("run.py uses FLOOM_RUN_ID but does not read WORKEROS_API_URL for the API proxy base");
  }
  return errors;
}

async function readOptionalText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function loadWorkerSource(dirArg: string): Promise<{ source?: WorkerSource; errors: string[] }> {
  const dir = resolve(dirArg);
  const errors: string[] = [];

  const workerYmlPath = join(dir, "worker.yml");
  const runPyPath = join(dir, "run.py");
  const skillMdPath = join(dir, "SKILL.md");

  let workerYml = "";
  try {
    workerYml = await readFile(workerYmlPath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") {
      return { errors: [`Missing required file: ${workerYmlPath}`] };
    }
    throw error;
  }

  let manifest: unknown;
  try {
    manifest = parseYaml(workerYml);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { errors: [`worker.yml is not valid YAML: ${message}`] };
  }

  if (!isRecord(manifest)) {
    return { errors: ["worker.yml must contain a YAML mapping"] };
  }

  const runPy = await readOptionalText(runPyPath);
  const skillMd = await readOptionalText(skillMdPath);
  const hasRunPy = Boolean(runPy?.trim());
  const hasSkillMd = Boolean(skillMd?.trim());

  if (!hasRunPy && !hasSkillMd) {
    errors.push("Worker directory must include a non-empty run.py or SKILL.md");
  }

  const workerId = nonEmptyString(manifest.id) || nonEmptyString(manifest.name);
  if (!workerId) {
    errors.push("worker.yml must include an id or name field");
  }

  const displayName = nonEmptyString(manifest.title) || nonEmptyString(manifest.name) || nonEmptyString(manifest.id);
  if (!displayName) {
    errors.push("worker.yml must include a name, title, or id field");
  }

  const runtime = readRuntime(manifest);
  if (!runtime) {
    errors.push("worker.yml must include a runtime field (runtime, runtime.type, exec.runtime, or exec.runtime.type)");
  }

  const entrypoint = readEntrypoint(manifest);
  if (entrypoint === "run.py" && !hasRunPy) {
    errors.push("worker.yml entrypoint is run.py, but run.py is missing or empty");
  }
  if (entrypoint === "SKILL.md" && !hasSkillMd) {
    errors.push("worker.yml entrypoint is SKILL.md, but SKILL.md is missing or empty");
  }
  if (entrypoint !== "SKILL.md") {
    errors.push(...validateNativeRuntimeContract(manifest, runPy));
  }

  if (errors.length > 0 || !workerId || !displayName || !runtime) {
    return { errors };
  }

  return {
    source: {
      dir,
      workerYml,
      runPy,
      skillMd,
      workerId,
      displayName,
      runtime,
      entrypoint,
    },
    errors: [],
  };
}

function sourcePayload(source: WorkerSource): WorkerSourcePayload {
  return {
    worker_yml: source.workerYml,
    run_py: source.runPy ?? "",
    ...(source.skillMd !== undefined ? { skill_md: source.skillMd } : {}),
  };
}

function emitValidationErrors(errors: string[]): number {
  for (const error of errors) {
    log.err(error);
  }
  return 1;
}

function apiErrorDetail(error: WorkerosApiError): string {
  const body = error.body;
  if (body && typeof body === "object" && "detail" in body) {
    return String((body as { detail: unknown }).detail);
  }
  return error.message;
}

function isExpiredAuthError(error: WorkerosApiError): boolean {
  if (error.status === 401) return true;
  if (error.status !== 403) return false;
  const detail = apiErrorDetail(error).toLowerCase();
  return detail.includes("expired") || detail.includes("invalid token") || detail.includes("invalid jwt");
}

function emitApiError(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Not logged in")) {
    return emitError("Not authenticated.", "Run: floom login");
  }
  if (error instanceof WorkerosConnectionError) {
    return emitError(
      "Workeros API is unreachable.",
      `Tried ${error.apiBase}. Check WORKEROS_API_BASE/FLOOM_API_BASE and network connectivity.`,
    );
  }
  if (error instanceof WorkerosApiError && isExpiredAuthError(error)) {
    return emitError("Your session expired.", "Re-run: floom login");
  }
  if (error instanceof WorkerosApiError && error.status === 403) {
    return emitError(
      "Request was forbidden.",
      `API said: ${apiErrorDetail(error)}. Check that this token can access the target worker/workspace.`,
    );
  }
  if (error instanceof WorkerosApiError && error.status && error.status >= 500) {
    return emitError(`API error: ${message}`, "Check API status, then retry. Report: https://github.com/floomhq/workeros/issues");
  }
  throw error;
}

export async function workersValidateCommand(dir: string): Promise<number> {
  const result = await loadWorkerSource(dir);
  if (!result.source) {
    return emitValidationErrors(result.errors);
  }
  log.ok(`Validated ${result.source.workerId}`);
  log.kv("Directory", result.source.dir);
  log.kv("Name", result.source.displayName);
  log.kv("Runtime", result.source.runtime);
  log.kv("Source", result.source.entrypoint === "SKILL.md" ? "SKILL.md" : result.source.runPy?.trim() ? "run.py" : "SKILL.md");
  return 0;
}

export async function workersPushCommand(dir: string): Promise<number> {
  const result = await loadWorkerSource(dir);
  if (!result.source) {
    return emitValidationErrors(result.errors);
  }

  const source = result.source;
  const payload = sourcePayload(source);

  try {
    const { client } = await createAuthenticatedClient();
    let exists = false;
    try {
      await client.requestJson("GET", `/workers/${encodeURIComponent(source.workerId)}`);
      exists = true;
    } catch (error) {
      if (error instanceof WorkerosApiError && error.status === 404) {
        exists = false;
      } else {
        throw error;
      }
    }

    if (!exists) {
      await client.requestJson("POST", "/workers", { body: payload });
      log.ok(`Created ${source.workerId}`);
      return 0;
    }

    try {
      await client.requestJson("PUT", `/workers/${encodeURIComponent(source.workerId)}`, { body: payload });
    } catch (error) {
      if (error instanceof WorkerosApiError && (error.status === 404 || error.status === 405)) {
        return emitError(
          "This Workeros API does not support in-place worker source updates.",
          `PUT /workers/${source.workerId} returned HTTP ${error.status}. Upgrade the API or use a new worker id.`,
        );
      }
      throw error;
    }

    log.ok(`Updated ${source.workerId}`);
    return 0;
  } catch (error) {
    return emitApiError(error);
  }
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
