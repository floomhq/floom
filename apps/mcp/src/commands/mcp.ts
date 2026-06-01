import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readCredentials } from "../lib/credentials.js";
import { log } from "../lib/output.js";

type JsonObject = Record<string, unknown>;

const PACKAGE_NAME = "@floomhq/workeros";
const DEFAULT_API_BASE = "https://workers-api.floom.dev";

// Targets that write a file (kind = "object" or "array" for config shape).
const FILE_CLIENTS = [
  { target: "claude",   name: "Claude Code", path: ".claude/settings.json",                      kind: "object" },
  { target: "cursor",   name: "Cursor",      path: ".cursor/mcp.json",                            kind: "object" },
  { target: "windsurf", name: "Windsurf",    path: ".codeium/windsurf/mcp_config.json",            kind: "object" },
  // VS Code: project-local first; fall back to user settings via --target vscode.
  // The VS Code MCP extension stores servers under the same mcpServers key as
  // Claude/Cursor when using the .vscode/mcp.json workspace file.
  { target: "vscode",   name: "VS Code",     path: ".vscode/mcp.json",                            kind: "object" },
  { target: "continue", name: "Continue",    path: ".continue/.continuerc.json",                  kind: "array"  },
] as const;

type FileTarget = (typeof FILE_CLIENTS)[number]["target"];
// "generic" is valid as a CLI --target but never writes a file.
export type ClientTarget = FileTarget | "generic";

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

function serverConfig(secret: string, apiBase: string, credentialEnv = "WORKEROS_API_SECRET"): JsonObject {
  return {
    command: "npx",
    args: ["-y", PACKAGE_NAME],
    env: {
      WORKEROS_API_BASE: apiBase,
      [credentialEnv]: secret,
    },
  };
}

function patchObjectConfig(config: JsonObject, secret: string, apiBase: string, credentialEnv?: string): JsonObject {
  const next = { ...config };
  const mcpServers =
    typeof next.mcpServers === "object" && next.mcpServers && !Array.isArray(next.mcpServers)
      ? { ...(next.mcpServers as JsonObject) }
      : {};
  mcpServers.workeros = serverConfig(secret, apiBase, credentialEnv);
  next.mcpServers = mcpServers;
  return next;
}

function patchContinueConfig(config: JsonObject, secret: string, apiBase: string, credentialEnv?: string): JsonObject {
  const next = { ...config };
  const servers = Array.isArray(next.mcpServers) ? [...next.mcpServers] : [];
  const entry = {
    name: "workeros",
    ...serverConfig(secret, apiBase, credentialEnv),
  };
  const existing = servers.findIndex((server) => (
    typeof server === "object" && server !== null && (server as JsonObject).name === "workeros"
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
    delete mcpServers.workeros;
    next.mcpServers = mcpServers;
  }
  return next;
}

function removeContinueConfig(config: JsonObject): JsonObject {
  const next = { ...config };
  const servers = Array.isArray(next.mcpServers) ? [...next.mcpServers] : [];
  next.mcpServers = servers.filter((server) => (
    !(typeof server === "object" && server !== null && (server as JsonObject).name === "workeros")
  ));
  return next;
}

/** Build the JSON snippet for a generic / manual install. */
function genericSnippet(secret: string, apiBase: string, credentialEnv = "WORKEROS_API_SECRET"): string {
  return JSON.stringify({
    mcpServers: {
      workeros: serverConfig(secret, apiBase, credentialEnv),
    },
  }, null, 2);
}

function manualSnippets(): string {
  const placeholder = "<WORKEROS_API_SECRET>";
  const objectSnippet = genericSnippet(placeholder, DEFAULT_API_BASE);
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
    objectSnippet,
  ].join("\n");
}

function selectFileClients(target: FileTarget): Array<(typeof FILE_CLIENTS)[number]> {
  return FILE_CLIENTS.filter((c) => c.target === target);
}

export async function mcpInstallCommand(options: { target?: ClientTarget }): Promise<number> {
  const home = resolveHomeDir();
  if (!home) throw new Error("HOME is required");

  const credentials = await readCredentials();
  const fallbackSecret = process.env.WORKEROS_API_SECRET?.trim();
  const fallbackToken = process.env.WORKEROS_API_TOKEN?.trim();
  const resolvedSecret = credentials?.api_secret || credentials?.api_token || fallbackSecret || fallbackToken;
  const credentialEnv = (credentials?.api_token || (!credentials?.api_secret && fallbackToken))
    ? "WORKEROS_API_TOKEN"
    : "WORKEROS_API_SECRET";
  const resolvedBase = credentials?.api_base || process.env.WORKEROS_API_BASE || DEFAULT_API_BASE;

  if (!resolvedSecret) {
    log.err("Not logged in. Cannot install MCP config without credentials.");
    log.info("Run: floom login");
    return 1;
  }

  // "generic" — print snippet for manual paste, no file written.
  if (options.target === "generic") {
    process.stdout.write(genericSnippet(resolvedSecret, resolvedBase, credentialEnv) + "\n");
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
      ? patchContinueConfig(config, resolvedSecret, resolvedBase, credentialEnv)
      : patchObjectConfig(config, resolvedSecret, resolvedBase, credentialEnv);
    await writeJson(configPath, patched);
    const displayPath = client.target === "vscode"
      ? client.path
      : `~/${client.path}`;
    log.ok(`Installed Workeros MCP config for ${client.name}`);
    log.kv("Config path", displayPath);
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
      ? patchContinueConfig(config, resolvedSecret, resolvedBase, credentialEnv)
      : patchObjectConfig(config, resolvedSecret, resolvedBase, credentialEnv);
    await writeJson(configPath, patched);
    const displayPath = client.target === "vscode"
      ? client.path
      : `~/${client.path}`;
    log.ok(`Installed Workeros MCP config for ${client.name} (auto-detected)`);
    log.kv("Config path", displayPath);
    return 0;
  }

  process.stdout.write(manualSnippets() + "\n");
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
    const displayPath = client.target === "vscode"
      ? client.path
      : `~/${client.path}`;
    log.ok(`Removed Workeros MCP config from ${client.name}`);
    log.kv("Config path", displayPath);
    return 0;
  }

  log.warn("No Workeros MCP config entries were found.");
  log.info("Install first: floom mcp install");
  return 0;
}
