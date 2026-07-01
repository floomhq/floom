import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAuthenticatedClient, FloomApiClient } from "../lib/api.js";
import { handleAuthError } from "../lib/cli-errors.js";
import { getCommandName } from "../lib/command-name.js";
import { readCredentials, updateCredentials } from "../lib/credentials.js";
import { log, printJson, renderTable } from "../lib/output.js";
import { runLoginCommand } from "./login.js";

type JsonObject = Record<string, unknown>;

const DEFAULT_CLOUD_API_BASE = "https://workeros-api.floom.dev";
const DEFAULT_OSS_API_BASE = "https://localhost:8000";
const MCP_SERVER_NAME = "floom";
const LEGACY_MCP_SERVER_NAME = "workeros";
const FLOOM_SKILL_ASSET_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "assets",
  "floom-skill.md",
);

// Targets that write a file (kind = "object" or "array" for config shape).
const FILE_CLIENTS = [
  { target: "claude",   name: "Claude Code", path: ".claude/settings.json",                     kind: "object" },
  { target: "cursor",   name: "Cursor",      path: ".cursor/mcp.json",                           kind: "object" },
  { target: "windsurf", name: "Windsurf",    path: ".codeium/windsurf/mcp_config.json",           kind: "object" },
  // VS Code: project-local first; fall back to user settings via --target vscode.
  { target: "vscode",   name: "VS Code",     path: ".vscode/mcp.json",                           kind: "object" },
  { target: "continue", name: "Continue",    path: ".continue/.continuerc.json",                 kind: "array"  },
] as const;

type FileTarget = (typeof FILE_CLIENTS)[number]["target"];
// "generic" is valid as a CLI --target but never writes a file.
export type ClientTarget = FileTarget | "generic";
type SkillClient = { target: ClientTarget };

function resolveHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || "";
}

function readJson(path: string): JsonObject {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw) as JsonObject;
}

async function writeJson(path: string, value: JsonObject): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function skillTargetPath(client: SkillClient, configPath: string): string {
  if (client.target === "claude") {
    return join(resolveHomeDir(), ".claude", "skills", "floom", "SKILL.md");
  }
  if (client.target === "cursor") {
    return join(process.cwd(), ".cursor", "rules", "floom.mdc");
  }
  if (client.target === "generic") {
    return join(process.cwd(), "FLOOM.md");
  }
  return join(dirname(configPath), "FLOOM.md");
}

export async function writeFloomSkillForClient(client: SkillClient, configPath: string): Promise<string | null> {
  try {
    const skillPath = skillTargetPath(client, configPath);
    const content = readFileSync(FLOOM_SKILL_ASSET_PATH, "utf8");
    await mkdir(dirname(skillPath), { recursive: true });
    await writeFile(skillPath, content, "utf8");
    return skillPath;
  } catch {
    return null;
  }
}

async function writeAndLogFloomSkill(
  client: SkillClient,
  configPath: string,
  displayPath?: string,
  stream: "stdout" | "stderr" = "stdout",
): Promise<void> {
  const skillPath = await writeFloomSkillForClient(client, configPath);
  if (skillPath) {
    const message = `Added Floom skill so your agent knows how to use it -> ${displayPath || skillPath}`;
    if (stream === "stderr") {
      process.stderr.write(`${message}\n`);
    } else {
      log.info(message);
    }
  }
}

function logInstallSuccessNextStep(): void {
  log.blank();
  log.ok("Floom is ready.");
  log.ok("Installed MCP for your agent.");
  log.info("Next: open your agent and ask:");
  log.blank();
  log.info('"Use Floom to create and run my first read-only worker."');
  log.blank();
  log.info("Tip: connect Gmail, GitHub, Slack, or Linear in Floom first for a better first worker.");
}

// HTTP MCP config — url + headers, no subprocess needed.
function serverConfig(mcpUrl: string, headers: Record<string, string>): JsonObject {
  return { url: mcpUrl, headers };
}

function patchObjectConfig(config: JsonObject, mcpUrl: string, headers: Record<string, string>): JsonObject {
  const next = { ...config };
  const mcpServers =
    typeof next.mcpServers === "object" && next.mcpServers && !Array.isArray(next.mcpServers)
      ? { ...(next.mcpServers as JsonObject) }
      : {};
  delete mcpServers[LEGACY_MCP_SERVER_NAME];
  mcpServers[MCP_SERVER_NAME] = serverConfig(mcpUrl, headers);
  next.mcpServers = mcpServers;
  return next;
}

function patchContinueConfig(config: JsonObject, mcpUrl: string, headers: Record<string, string>): JsonObject {
  const next = { ...config };
  const servers = Array.isArray(next.mcpServers) ? [...next.mcpServers] : [];
  const entry = {
    name: MCP_SERVER_NAME,
    ...serverConfig(mcpUrl, headers),
  };
  const existing = servers.findIndex((server) => (
    typeof server === "object" &&
    server !== null &&
    [MCP_SERVER_NAME, LEGACY_MCP_SERVER_NAME].includes(String((server as JsonObject).name))
  ));
  if (existing === -1) {
    servers.push(entry);
  } else {
    servers[existing] = entry;
  }
  next.mcpServers = servers;
  return next;
}

function removeObjectConfig(config: JsonObject): JsonObject {
  const next = { ...config };
  if (typeof next.mcpServers === "object" && next.mcpServers && !Array.isArray(next.mcpServers)) {
    const mcpServers = { ...(next.mcpServers as JsonObject) };
    delete mcpServers[MCP_SERVER_NAME];
    delete mcpServers[LEGACY_MCP_SERVER_NAME];
    next.mcpServers = mcpServers;
  }
  return next;
}

function removeContinueConfig(config: JsonObject): JsonObject {
  const next = { ...config };
  const servers = Array.isArray(next.mcpServers) ? [...next.mcpServers] : [];
  next.mcpServers = servers.filter((server) => (
    !(typeof server === "object" &&
      server !== null &&
      [MCP_SERVER_NAME, LEGACY_MCP_SERVER_NAME].includes(String((server as JsonObject).name)))
  ));
  return next;
}

function genericSnippet(mcpUrl: string, headers: Record<string, string>): string {
  return JSON.stringify({
    mcpServers: {
      [MCP_SERVER_NAME]: serverConfig(mcpUrl, headers),
    },
  }, null, 2);
}

function redactedHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.keys(headers).map((key) => [key, `<${key}>`]),
  );
}

function manualSnippets(mcpUrl: string, headers: Record<string, string>): string {
  const snippet = genericSnippet(mcpUrl, redactedHeaders(headers));
  return [
    "No supported MCP client config was found.",
    "Create one of these files and add the snippet below:",
    "- ~/.claude/settings.json         (--target claude)",
    "- ~/.cursor/mcp.json              (--target cursor)",
    "- ~/.codeium/windsurf/mcp_config.json  (--target windsurf)",
    "- .vscode/mcp.json                (--target vscode, workspace-local)",
    "- ~/.continue/.continuerc.json    (--target continue)",
    "Or run with --target generic to print this snippet and paste it manually.",
    "",
    snippet,
  ].join("\n");
}

function selectFileClients(target: FileTarget): Array<(typeof FILE_CLIENTS)[number]> {
  return FILE_CLIENTS.filter((c) => c.target === target);
}

function isSupportedTarget(target: string): target is ClientTarget {
  return target === "generic" || FILE_CLIENTS.some((client) => client.target === target);
}

type McpConfig = { mcpUrl: string; headers: Record<string, string> };

type WorkspaceRow = { id: string; name?: string };
type WorkspaceListEnvelope = { workspaces?: WorkspaceRow[]; active_id?: string | null };

function resolveWorkspaceFromPayload(payload: unknown): WorkspaceRow | null {
  const workspaces = Array.isArray(payload)
    ? payload as WorkspaceRow[]
    : Array.isArray((payload as WorkspaceListEnvelope | null)?.workspaces)
      ? (payload as WorkspaceListEnvelope).workspaces!
      : [];
  if (workspaces.length === 0) return null;
  const activeId = !Array.isArray(payload) ? (payload as WorkspaceListEnvelope).active_id : null;
  if (activeId) {
    return workspaces.find((workspace) => workspace.id === activeId) || { id: activeId };
  }
  return workspaces.length === 1 ? workspaces[0] : null;
}

async function resolveMcpConfig(
  credentials: NonNullable<Awaited<ReturnType<typeof readCredentials>>>,
  apiBase: string,
): Promise<McpConfig> {
  if (credentials.mode === "oss") {
    if (!credentials.api_secret) {
      throw new Error(`OSS credentials missing api_secret. Run: ${getCommandName()} login`);
    }
    const headers: Record<string, string> = { "x-floom-secret": credentials.api_secret };
    // OSS scopes by header, not URL: bake the active workspace in so the MCP
    // session lands on the selected workspace instead of the default one.
    if (credentials.workspace_id) {
      headers["x-workeros-workspace"] = credentials.workspace_id;
    }
    // Self-hosted engines with user-header scope require x-floom-user.
    if (credentials.user) {
      headers["x-floom-user"] = credentials.user;
    }
    return {
      mcpUrl: `${apiBase}/mcp-tools/serve`,
      headers,
    };
  }

  // Hosted mode requires a PAT — JWTs expire hourly and cannot be embedded in
  // a static MCP config. PATs do not expire.
  const pat = credentials.api_token;
  if (!pat) {
    throw new Error(
      "Cloud MCP install requires a Personal Access Token (PAT).\n" +
      "Generate one in the dashboard, then set FLOOM_TOKEN or WORKEROS_API_TOKEN before running MCP install.",
    );
  }

  // Resolve the workspace_id: stored in credentials, set via env var, or fetched from API.
  let workspaceId = credentials.workspace_id || process.env.WORKEROS_WORKSPACE_ID?.trim();
  if (!workspaceId) {
    const client = new FloomApiClient(apiBase, credentials);
    try {
      const payload = await client.requestJson("GET", "/api/workspaces");
      const workspace = resolveWorkspaceFromPayload(payload);
      if (!workspace) {
        throw new Error("No workspaces found. Create a workspace first at https://floom.ai");
      }
      workspaceId = workspace.id;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Could not resolve workspace ID. Set WORKEROS_WORKSPACE_ID or run: ${getCommandName()} login\nDetails: ${msg}`,
      );
    }
  }

  return {
    mcpUrl: `${apiBase}/mcp/${workspaceId}`,
    headers: { Authorization: `Bearer ${pat}` },
  };
}

export async function mcpInstallCommand(options: { target?: ClientTarget; showToken?: boolean }): Promise<number> {
  const home = resolveHomeDir();
  if (!home) throw new Error("HOME is required");

  if (options.target && !isSupportedTarget(options.target)) {
    log.err(`Unknown target: ${options.target}`);
    log.info("Supported targets: claude | cursor | vscode | windsurf | continue | generic");
    return 1;
  }

  let credentials = await readCredentials();
  if (!credentials) {
    log.info("No saved Floom credentials found. Starting login...");
    const loginResult = await runLoginCommand({});
    if (loginResult !== 0) {
      return loginResult;
    }
    credentials = await readCredentials();
    if (!credentials) {
      log.err("Login completed but no credentials were saved.");
      return 1;
    }
  }

  const resolvedBase = (
    credentials.api_base ||
    process.env.FLOOM_API_BASE ||
    process.env.WORKEROS_API_BASE ||
    (credentials.mode === "cloud" ? DEFAULT_CLOUD_API_BASE : DEFAULT_OSS_API_BASE)
  ).replace(/\/+$/, "");

  let mcpConfig: McpConfig;
  try {
    mcpConfig = await resolveMcpConfig(credentials, resolvedBase);
  } catch (err) {
    log.err(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const { mcpUrl, headers } = mcpConfig;

  // "generic" — print snippet for manual paste, no file written.
  if (options.target === "generic") {
    if (options.showToken) {
      log.warn(
        "Printing a live credential. Do not paste this into logs, screenshots, support tickets, or shared terminals.",
      );
      process.stdout.write(genericSnippet(mcpUrl, headers) + "\n");
    } else {
      process.stdout.write(genericSnippet(mcpUrl, redactedHeaders(headers)) + "\n");
      log.info(
        `Credentials are redacted by default. Re-run \`${getCommandName()} mcp install --target generic --show-token\` only when you are ready to paste into a private MCP config.`,
      );
    }
    await writeAndLogFloomSkill({ target: "generic" }, join(process.cwd(), "FLOOM.md"), "FLOOM.md", "stderr");
    return 0;
  }

  if (options.target) {
    // Explicit target: write unconditionally (create file if absent).
    const clients = selectFileClients(options.target as FileTarget);
    if (clients.length === 0) {
      log.err(`Unknown target: ${options.target}`);
      log.info("Supported targets: claude | cursor | vscode | windsurf | continue | generic");
      return 1;
    }
    const client = clients[0];
    // VS Code workspace config lives relative to CWD, not HOME.
    const configPath = client.target === "vscode"
      ? join(process.cwd(), client.path)
      : join(home, client.path);
    const config = readJson(configPath);
    const patched = client.kind === "array"
      ? patchContinueConfig(config, mcpUrl, headers)
      : patchObjectConfig(config, mcpUrl, headers);
    await writeJson(configPath, patched);
    const displayPath = client.target === "vscode" ? client.path : `~/${client.path}`;
    log.ok(`Installed Floom MCP config for ${client.name}`);
    log.kv("Config path", displayPath);
    await writeAndLogFloomSkill(client, configPath);
    logInstallSuccessNextStep();
    return 0;
  }

  // No --target: auto-detect the first existing config file.
  for (const client of FILE_CLIENTS) {
    const configPath = client.target === "vscode"
      ? join(process.cwd(), client.path)
      : join(home, client.path);
    if (!existsSync(configPath)) continue;
    const config = readJson(configPath);
    const patched = client.kind === "array"
      ? patchContinueConfig(config, mcpUrl, headers)
      : patchObjectConfig(config, mcpUrl, headers);
    await writeJson(configPath, patched);
    const displayPath = client.target === "vscode" ? client.path : `~/${client.path}`;
    log.ok(`Installed Floom MCP config for ${client.name} (auto-detected)`);
    log.kv("Config path", displayPath);
    await writeAndLogFloomSkill(client, configPath);
    logInstallSuccessNextStep();
    return 0;
  }

  log.info("No supported MCP client config was found; defaulting to --target generic.");
  process.stdout.write(manualSnippets(mcpUrl, headers) + "\n");
  await writeAndLogFloomSkill({ target: "generic" }, join(process.cwd(), "FLOOM.md"), "FLOOM.md", "stderr");
  return 0;
}

export async function mcpUninstallCommand(options: { target?: ClientTarget }): Promise<number> {
  const home = resolveHomeDir();
  if (!home) throw new Error("HOME is required");

  if (options.target === "generic") {
    log.warn("generic target writes no file — nothing to uninstall.");
    return 0;
  }

  const candidates = options.target
    ? selectFileClients(options.target as FileTarget)
    : [...FILE_CLIENTS];

  for (const client of candidates) {
    const configPath = client.target === "vscode"
      ? join(process.cwd(), client.path)
      : join(home, client.path);
    if (!existsSync(configPath)) continue;
    const config = readJson(configPath);
    const patched = client.kind === "array" ? removeContinueConfig(config) : removeObjectConfig(config);
    await writeJson(configPath, patched);
    const displayPath = client.target === "vscode" ? client.path : `~/${client.path}`;
    log.ok(`Removed Floom MCP config from ${client.name}`);
    log.kv("Config path", displayPath);
    return 0;
  }

  log.warn("No Floom MCP config entries were found.");
  log.info(`Install first: ${getCommandName()} mcp install`);
  return 0;
}

type McpConnectionRow = {
  id?: string;
  kind?: string;
  mcp_label?: string;
  app_name?: string;
  display_name?: string;
  status?: string;
  mcp_transport?: string;
};

function mcpRowLabel(row: McpConnectionRow): string {
  return String(row.mcp_label || row.display_name || row.app_name || "");
}

async function fetchMcpConnections(client: FloomApiClient): Promise<McpConnectionRow[]> {
  const rows = (await client.requestJson("GET", "/connections")) as McpConnectionRow[];
  return (Array.isArray(rows) ? rows : []).filter((row) => (row.kind || "composio") === "mcp");
}

export async function mcpListCommand(options: { json?: boolean }): Promise<number> {
  try {
    const { client, credentials } = await createAuthenticatedClient();
    const servers = await fetchMcpConnections(client);
    const active = (credentials.active_mcp_label || "").toLowerCase();
    if (options.json) {
      printJson(servers.map((row) => ({
        ...row,
        active: !!active && mcpRowLabel(row).toLowerCase() === active,
      })));
      return 0;
    }
    if (servers.length === 0) {
      log.info("No MCP servers configured.");
      log.info(`Add one: ${getCommandName()} connections import-mcp-config <path>`);
      return 0;
    }
    process.stdout.write(renderTable(
      servers.map((row) => ({
        Active: mcpRowLabel(row).toLowerCase() === active && active ? "*" : " ",
        Label: mcpRowLabel(row),
        Transport: row.mcp_transport || "streamable_http",
        Status: row.status || "-",
      })),
      [
        { key: "Active", label: " " },
        { key: "Label", label: "Label" },
        { key: "Transport", label: "Transport" },
        { key: "Status", label: "Status" },
      ],
    ) + "\n");
    return 0;
  } catch (error) {
    const handled = handleAuthError(error, options);
    if (handled !== null) return handled;
    throw error;
  }
}

export async function mcpSwitchCommand(target: string): Promise<number> {
  try {
    const { client } = await createAuthenticatedClient();
    const needle = target.trim().toLowerCase();
    if (!needle) {
      log.err("MCP server name is required");
      return 1;
    }
    const servers = await fetchMcpConnections(client);
    const match = servers.find((row) => mcpRowLabel(row).toLowerCase() === needle);
    if (!match) {
      log.err(`No configured MCP server matches "${target}".`);
      process.stderr.write(
        `Run \`${getCommandName()} mcp list\` to see configured servers, or add one with ` +
        `\`${getCommandName()} connections import-mcp-config <path>\`.\n`,
      );
      return 1;
    }
    const label = mcpRowLabel(match);
    await updateCredentials({ active_mcp_label: label });
    log.ok(`Active MCP server set to ${label}.`);
    log.step(`Verify it responds: ${getCommandName()} mcp test`);
    return 0;
  } catch (error) {
    const handled = handleAuthError(error);
    if (handled !== null) return handled;
    throw error;
  }
}

type McpTestResult = {
  status?: string;
  reason?: string;
  tested_at?: string;
  tools?: string[] | null;
};

// Tests the named MCP server, or the active one (`floom mcp switch`) when no
// name is given. The API probes the server live: MCP initialize + tools/list.
export async function mcpTestCommand(
  target: string | undefined,
  options: { json?: boolean },
): Promise<number> {
  try {
    const { client, credentials } = await createAuthenticatedClient();
    const name = (target || credentials.active_mcp_label || "").trim();
    if (!name) {
      log.err("No MCP server specified and no active one is set.");
      process.stderr.write(`Run \`${getCommandName()} mcp switch <name>\` first, or pass a name: ${getCommandName()} mcp test <name>\n`);
      return 1;
    }
    const servers = await fetchMcpConnections(client);
    const needle = name.toLowerCase();
    const match = servers.find((row) => mcpRowLabel(row).toLowerCase() === needle);
    if (!match || !match.id) {
      log.err(`No configured MCP server matches "${name}".`);
      process.stderr.write(`Run \`${getCommandName()} mcp list\` to see configured servers.\n`);
      return 1;
    }
    const result = (await client.requestJson(
      "POST",
      `/connections/${encodeURIComponent(match.id)}/test`,
    )) as McpTestResult;
    const valid = result.status === "valid";
    if (options.json) {
      printJson({ label: mcpRowLabel(match), ...result });
      return valid ? 0 : 1;
    }
    if (valid) {
      log.ok(`${mcpRowLabel(match)} is reachable.`);
    } else {
      log.err(`${mcpRowLabel(match)} failed: ${result.reason || result.status || "unknown error"}`);
    }
    if (result.tools && result.tools.length) {
      log.kv("Tools", `${result.tools.length} (${result.tools.slice(0, 8).join(", ")}${result.tools.length > 8 ? ", …" : ""})`);
    }
    return valid ? 0 : 1;
  } catch (error) {
    const handled = handleAuthError(error, options);
    if (handled !== null) return handled;
    throw error;
  }
}
