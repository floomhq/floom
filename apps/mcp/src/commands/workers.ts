import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { inspect } from "node:util";
import { parse as parseYaml } from "yaml";
import { createAuthenticatedClient, FloomApiError, FloomConnectionError } from "../lib/api.js";
import { getCommandName } from "../lib/command-name.js";
import { log, printJson, renderTable } from "../lib/output.js";
import { promptYesNo } from "../lib/prompt.js";

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
    connections?: Array<string | Record<string, unknown>>;
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
  files: Array<{ path: string; content: string }>;
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

type WorkerFilesPayload = {
  files: Array<{ path: string; content: string }>;
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

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
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

function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function validateTriggerTimezone(trigger: unknown, path: string): string[] {
  if (!isRecord(trigger)) return [];
  const timezone = nonEmptyString(trigger.timezone);
  if (!timezone || isValidTimeZone(timezone)) return [];
  return [`${path}.timezone is not a valid IANA timezone: ${timezone}`];
}

function validateTimezones(manifest: Record<string, unknown>): string[] {
  const errors: string[] = [];
  errors.push(...validateTriggerTimezone(manifest.trigger, "trigger"));
  const cronTimezone = nonEmptyString(manifest.cron_timezone);
  if (cronTimezone && !isValidTimeZone(cronTimezone)) {
    errors.push(`cron_timezone is not a valid IANA timezone: ${cronTimezone}`);
  }
  if (Array.isArray(manifest.triggers)) {
    manifest.triggers.forEach((trigger, index) => {
      errors.push(...validateTriggerTimezone(trigger, `triggers[${index}]`));
    });
  }
  return errors;
}

function validateWorkerContractShape(manifest: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (Array.isArray(manifest.use_cases)) {
    if (manifest.use_cases.length < 3 || manifest.use_cases.length > 5) {
      errors.push("use_cases must contain 3 to 5 items");
    }
    manifest.use_cases.forEach((item, index) => {
      if (typeof item !== "string" || !item.trim()) {
        errors.push(`use_cases.${index} must be a non-empty string`);
      }
    });
  }

  const validateFields = (value: unknown, path: string) => {
    if (!Array.isArray(value)) return;
    value.forEach((field, index) => {
      if (!isRecord(field)) return;
      if ("placeholder" in field && field.placeholder !== undefined && field.placeholder !== null && typeof field.placeholder !== "string") {
        errors.push(`${path}.${index}.placeholder must be a string`);
      }
    });
  };

  validateFields(manifest.inputs, "inputs");
  validateFields(manifest.outputs, "outputs");
  const exec = readNestedRecord(manifest, "exec");
  if (exec) {
    validateFields(exec.inputs, "exec.inputs");
    validateFields(exec.outputs, "exec.outputs");
  }
  return errors;
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

function toolApp(toolSlug: string, declared: Map<string, Set<string> | null>): string {
  const normalized = toolSlug.toUpperCase();
  const matches = [...declared.keys()].filter((app) =>
    normalized.startsWith(`${app.toUpperCase().replaceAll("-", "_")}_`),
  );
  if (matches.length > 0) return matches.sort((a, b) => b.length - a.length)[0];
  const allowlistMatches = [...declared.entries()]
    .filter(([, allowedTools]) => allowedTools !== null && allowedTools.has(normalized))
    .map(([app]) => app);
  if (allowlistMatches.length === 0) return "";
  return allowlistMatches.sort((a, b) => b.length - a.length)[0];
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
      "run.py shells out to `composio execute`; E2B workers must call the Floom proxy at /runs/{FLOOM_RUN_ID}/composio-execute/{TOOL_SLUG}",
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
    const app = toolApp(slug, declared);
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
    return stripUtf8Bom(await readFile(path, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function stripUtf8Bom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

const IGNORED_BUNDLE_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".venv",
  "venv",
  "node_modules",
]);

const IGNORED_BUNDLE_FILES = new Set([".DS_Store"]);
const SECRET_BUNDLE_FILE_RE = /(^|\/)(?:\.env(?:\..*)?|credentials\.json|.*\.(?:pem|key|p12|pfx))$/i;

function toBundlePath(root: string, absolutePath: string): string {
  return absolutePath.slice(root.length + 1).replaceAll("\\", "/");
}

function looksBinary(buffer: Buffer): boolean {
  return buffer.includes(0);
}

async function collectWorkerFiles(dir: string): Promise<{ files: Array<{ path: string; content: string }>; errors: string[] }> {
  const files: Array<{ path: string; content: string }> = [];
  const errors: string[] = [];

  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && IGNORED_BUNDLE_DIRS.has(entry.name)) continue;
      if (entry.isFile() && IGNORED_BUNDLE_FILES.has(entry.name)) continue;
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const info = await stat(absolute);
      const relPath = toBundlePath(dir, absolute);
      if (SECRET_BUNDLE_FILE_RE.test(relPath)) {
        errors.push(`${relPath} looks like credential material; store credentials in Floom secrets instead`);
        continue;
      }
      if (info.size > 5 * 1024 * 1024) {
        errors.push(`${relPath} is larger than 5MB; use runtime download/storage for large assets`);
        continue;
      }
      const content = await readFile(absolute);
      if (looksBinary(content)) {
        errors.push(`${relPath} appears to be binary; workers push currently supports UTF-8 bundle files`);
        continue;
      }
      files.push({ path: relPath, content: stripUtf8Bom(content.toString("utf8")) });
    }
  }

  await walk(dir);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, errors };
}

export async function loadWorkerSource(dirArg: string): Promise<{ source?: WorkerSource; errors: string[] }> {
  const dir = resolve(dirArg);
  const errors: string[] = [];

  const workerYmlPath = join(dir, "worker.yml");
  const runPyPath = join(dir, "run.py");
  const skillMdPath = join(dir, "SKILL.md");

  let workerYml = "";
  try {
    workerYml = stripUtf8Bom(await readFile(workerYmlPath, "utf8"));
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
  const collected = await collectWorkerFiles(dir);
  errors.push(...collected.errors);
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
  errors.push(...validateTimezones(manifest));
  errors.push(...validateWorkerContractShape(manifest));

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
      files: collected.files,
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

function filesPayload(source: WorkerSource): WorkerFilesPayload {
  return { files: source.files };
}

function hasNonLegacyBundleFiles(source: WorkerSource): boolean {
  const legacyPaths = new Set(["worker.yml", "run.py", "SKILL.md"]);
  return source.files.some((file) => !legacyPaths.has(file.path));
}

function emitValidationErrors(errors: string[]): number {
  for (const error of errors) {
    log.err(error);
  }
  return 1;
}

function workerConnectionLabel(connection: Record<string, unknown>): string {
  const composio = readNestedRecord(connection, "composio");
  const candidates = [
    connection.display_name,
    connection.account_label,
    connection.provider,
    connection.app,
    connection.name,
    connection.mcp_label,
    composio?.provider,
    composio?.app,
    connection.id,
  ];
  for (const candidate of candidates) {
    const value = nonEmptyString(candidate);
    if (value) return value;
  }
  return "";
}

function workerConnectionDetails(connection: Record<string, unknown>): string[] {
  const details: string[] = [];
  const status = nonEmptyString(connection.status);
  if (status) details.push(`status: ${status}`);

  const label = workerConnectionLabel(connection);
  const account = nonEmptyString(connection.account_label) || nonEmptyString(connection.display_name);
  if (account && account !== label) {
    details.push(`account: ${account}`);
  }

  const scopes = stringList(connection.scopes);
  if (scopes.length > 0) {
    details.push(`scopes: ${scopes.join(", ")}`);
  }

  const allowedTools = stringList(connection.allowed_tools);
  const composio = readNestedRecord(connection, "composio");
  const composioAllowedTools = composio ? stringList(composio.allowed_tools) : [];
  const mergedAllowedTools = [...new Set([...allowedTools, ...composioAllowedTools])];
  if (mergedAllowedTools.length > 0) {
    details.push(`allowed_tools: ${mergedAllowedTools.join(", ")}`);
  }

  const expiresAt = nonEmptyString(connection.expires_at) || nonEmptyString(connection.expiresAt);
  if (expiresAt) {
    details.push(`expires_at: ${expiresAt}`);
  }

  return details;
}

function formatConnection(connection: unknown): string {
  if (typeof connection === "string") return connection;
  if (!isRecord(connection)) return String(connection ?? "");

  const label = workerConnectionLabel(connection);
  const details = workerConnectionDetails(connection);
  if (label && details.length === 0) return label;
  if (label) return `${label}${details.length > 0 ? ` (${details.join("; ")})` : ""}`;
  if (details.length > 0) return `connection (${details.join("; ")})`;
  return inspect(connection, { depth: 1, compact: true, breakLength: 80, sorted: true });
}

function formatConnections(connections: unknown): string[] {
  if (!Array.isArray(connections) || connections.length === 0) return [];
  return connections.map((connection) => formatConnection(connection)).filter(Boolean);
}

function apiErrorDetail(error: FloomApiError): string {
  const body = error.body;
  if (body && typeof body === "object" && "detail" in body) {
    const detail = (body as { detail: unknown }).detail;
    return typeof detail === "string" ? detail : JSON.stringify(detail);
  }
  return error.message;
}

function isExpiredAuthError(error: FloomApiError): boolean {
  if (error.status === 401) return true;
  if (error.status !== 403) return false;
  const detail = apiErrorDetail(error).toLowerCase();
  return detail.includes("expired") || detail.includes("invalid token") || detail.includes("invalid jwt");
}

function emitApiError(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Not logged in")) {
    return emitError("Not authenticated.", `Run: ${getCommandName()} login`);
  }
  if (error instanceof FloomConnectionError) {
    return emitError(
      "Floom API is unreachable.",
      `Tried ${error.apiBase}. Check WORKEROS_API_BASE/FLOOM_API_BASE and network connectivity.`,
    );
  }
  if (error instanceof FloomApiError && isExpiredAuthError(error)) {
    return emitError("Your session expired.", `Re-run: ${getCommandName()} login`);
  }
  if (error instanceof FloomApiError && error.status === 403) {
    return emitError(
      "Request was forbidden.",
      `API said: ${apiErrorDetail(error)}. Check that this token can access the target worker/workspace.`,
    );
  }
  if (error instanceof FloomApiError && error.status && error.status >= 500) {
    return emitError(`API error: ${message}`, "Check API status, then retry. Report: https://github.com/floomhq/floom/issues");
  }
  if (error instanceof FloomApiError && error.status && error.status >= 400) {
    return emitError(`API rejected worker source: ${apiErrorDetail(error)}`, `Fix the worker files and retry: ${getCommandName()} workers validate <dir>`);
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
      if (error instanceof FloomApiError && error.status === 404) {
        exists = false;
      } else {
        throw error;
      }
    }

    if (!exists) {
      try {
        await client.requestJson("POST", "/workers", { body: payload });
      } catch (error) {
        if (error instanceof FloomApiError && error.status === 409 && /already exists/i.test(apiErrorDetail(error))) {
          return emitError(
            `Worker id '${source.workerId}' already exists outside the active workspace.`,
            `Choose a unique worker id in worker.yml, then run: ${getCommandName()} workers validate <dir> && ${getCommandName()} workers push <dir>`,
          );
        }
        throw error;
      }
      if (hasNonLegacyBundleFiles(source)) {
        try {
          await client.requestJson("PUT", `/workers/${encodeURIComponent(source.workerId)}/files`, { body: filesPayload(source) });
        } catch (error) {
          if (error instanceof FloomApiError && (error.status === 404 || error.status === 405)) {
            return emitError(
              "This Floom API created the worker but does not support full worker bundle uploads.",
              `PUT /workers/${source.workerId}/files returned HTTP ${error.status}. Upgrade the API before pushing workers with data/ or lib/ files.`,
            );
          }
          throw error;
        }
      }
      log.ok(`Created ${source.workerId}`);
      return 0;
    }

    try {
      await client.requestJson("PUT", `/workers/${encodeURIComponent(source.workerId)}/files`, { body: filesPayload(source) });
    } catch (error) {
      if (error instanceof FloomApiError && (error.status === 404 || error.status === 405)) {
        return emitError(
          "This Floom API does not support full worker bundle updates.",
          `PUT /workers/${source.workerId}/files returned HTTP ${error.status}. Upgrade the API or use a new worker id.`,
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
      return emitError("Not authenticated.", `Run: ${getCommandName()} login`, options.json);
    }
    if (error instanceof FloomApiError && (error.status === 401 || error.status === 403)) {
      return emitError("Your session expired.", `Re-run: ${getCommandName()} login`, options.json);
    }
    if (error instanceof FloomApiError && error.status && error.status >= 500) {
      return emitError(`API error: ${message}`, "Check API status, then retry. Report: https://github.com/floomhq/floom/issues", options.json);
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
    const connections = formatConnections(worker.config?.connections);
    if (connections.length === 0) {
      process.stdout.write("Connections: none\n");
    } else {
      process.stdout.write("Connections:\n");
      for (const connection of connections) {
        process.stdout.write(`  - ${connection}\n`);
      }
    }
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
      return emitError("Not authenticated.", `Run: ${getCommandName()} login`, options.json);
    }
    if (error instanceof FloomApiError && error.status === 404) {
      return emitError(`Worker '${workerId}' not found.`, `List available workers: ${getCommandName()} workers list`, options.json);
    }
    if (error instanceof FloomApiError && (error.status === 401 || error.status === 403)) {
      return emitError("Your session expired.", `Re-run: ${getCommandName()} login`, options.json);
    }
    if (error instanceof FloomApiError && error.status && error.status >= 500) {
      return emitError(`API error: ${message}`, "Check API status, then retry. Report: https://github.com/floomhq/floom/issues", options.json);
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

    const connections = formatConnections(worker.config?.connections);
    if (connections.length === 0) {
      log.kv("Connections", "none");
    } else {
      log.kv("Connections", connections[0]);
      for (const connection of connections.slice(1)) {
        log.info(`  ${connection}`);
      }
    }

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
    log.info(`Try: ${getCommandName()} run ${workerId}`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Not logged in")) {
      return emitError("Not authenticated.", `Run: ${getCommandName()} login`, options.json);
    }
    if (error instanceof FloomApiError && error.status === 404) {
      return emitError(`Worker '${workerId}' not found.`, `List available workers: ${getCommandName()} workers list`, options.json);
    }
    if (error instanceof FloomApiError && (error.status === 401 || error.status === 403)) {
      return emitError("Your session expired.", `Re-run: ${getCommandName()} login`, options.json);
    }
    if (error instanceof FloomApiError && error.status && error.status >= 500) {
      return emitError(`API error: ${message}`, "Check API status, then retry. Report: https://github.com/floomhq/floom/issues", options.json);
    }
    throw error;
  }
}

function emitLifecycleError(error: unknown, workerId: string, json?: boolean): number {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Not logged in")) {
    return emitError("Not authenticated.", `Run: ${getCommandName()} login`, json);
  }
  if (error instanceof FloomConnectionError) {
    return emitError(
      "Floom API is unreachable.",
      `Tried ${error.apiBase}. Check WORKEROS_API_BASE/FLOOM_API_BASE and network connectivity.`,
      json,
    );
  }
  if (error instanceof FloomApiError && error.status === 404) {
    return emitError(`Worker '${workerId}' not found.`, `List available workers: ${getCommandName()} workers list`, json);
  }
  if (error instanceof FloomApiError && isExpiredAuthError(error)) {
    return emitError("Your session expired.", `Re-run: ${getCommandName()} login`, json);
  }
  if (error instanceof FloomApiError && error.status === 403) {
    return emitError(
      "Request was forbidden.",
      `API said: ${apiErrorDetail(error)}. Check that this token can manage the target worker/workspace.`,
      json,
    );
  }
  if (error instanceof FloomApiError && error.status && error.status >= 500) {
    return emitError(`API error: ${message}`, "Check API status, then retry. Report: https://github.com/floomhq/floom/issues", json);
  }
  if (error instanceof FloomApiError && error.status && error.status >= 400) {
    return emitError(`API rejected request: ${apiErrorDetail(error)}`, `Check the worker id and try again: ${getCommandName()} workers list`, json);
  }
  throw error;
}

export async function workersDeleteCommand(workerId: string, options: { yes?: boolean; json?: boolean }): Promise<number> {
  try {
    const { client } = await createAuthenticatedClient();
    const confirmed = options.yes
      || await promptYesNo(`Delete worker ${workerId}? This removes its runs and artifacts and cannot be undone. [y/N] `, false);
    if (!confirmed) {
      log.info("Cancelled.");
      return 0;
    }
    await client.requestJson("DELETE", `/workers/${encodeURIComponent(workerId)}`);
    if (options.json) {
      printJson({ id: workerId, deleted: true });
    } else {
      log.ok(`Deleted ${workerId}`);
    }
    return 0;
  } catch (error) {
    return emitLifecycleError(error, workerId, options.json);
  }
}

export async function workersDisableCommand(workerId: string, options: { json?: boolean }): Promise<number> {
  try {
    const { client } = await createAuthenticatedClient();
    const worker = (await client.requestJson("POST", `/workers/${encodeURIComponent(workerId)}/pause`)) as WorkerDetail;
    if (options.json) {
      printJson(worker);
    } else {
      log.ok(`Disabled ${workerId}`);
      log.info(`It stays in the workspace but will not run on triggers. Re-enable: ${getCommandName()} workers enable ${workerId}`);
    }
    return 0;
  } catch (error) {
    return emitLifecycleError(error, workerId, options.json);
  }
}

export async function workersEnableCommand(workerId: string, options: { json?: boolean }): Promise<number> {
  try {
    const { client } = await createAuthenticatedClient();
    const worker = (await client.requestJson("POST", `/workers/${encodeURIComponent(workerId)}/resume`)) as WorkerDetail;
    if (options.json) {
      printJson(worker);
    } else {
      log.ok(`Enabled ${workerId}`);
    }
    return 0;
  } catch (error) {
    return emitLifecycleError(error, workerId, options.json);
  }
}
