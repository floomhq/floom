import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readCredentials } from "../lib/credentials.js";

type JsonObject = Record<string, unknown>;

const PACKAGE_NAME = "@floomhq/workeros";

const CLIENTS = [
  { target: "claude", name: "Claude Code", path: ".claude/settings.json", kind: "object" },
  { target: "cursor", name: "Cursor", path: ".cursor/mcp.json", kind: "object" },
  { target: "continue", name: "Continue", path: ".continue/.continuerc.json", kind: "array" },
] as const;

type ClientTarget = (typeof CLIENTS)[number]["target"];

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

function serverConfig(secret: string, apiBase: string): JsonObject {
  return {
    command: "npx",
    args: ["-y", PACKAGE_NAME],
    env: {
      WORKEROS_API_SECRET: secret,
      WORKEROS_API_BASE: apiBase,
    },
  };
}

function patchObjectConfig(config: JsonObject, secret: string, apiBase: string): JsonObject {
  const next = { ...config };
  const mcpServers =
    typeof next.mcpServers === "object" && next.mcpServers && !Array.isArray(next.mcpServers)
      ? { ...(next.mcpServers as JsonObject) }
      : {};
  mcpServers.workeros = serverConfig(secret, apiBase);
  next.mcpServers = mcpServers;
  return next;
}

function patchContinueConfig(config: JsonObject, secret: string, apiBase: string): JsonObject {
  const next = { ...config };
  const servers = Array.isArray(next.mcpServers) ? [...next.mcpServers] : [];
  const entry = {
    name: "workeros",
    ...serverConfig(secret, apiBase),
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

function manualSnippets(): string {
  const placeholder = "<WORKEROS_API_SECRET>";
  const objectSnippet = JSON.stringify({
    mcpServers: {
      workeros: {
        command: "npx",
        args: ["-y", PACKAGE_NAME],
        env: {
          WORKEROS_API_SECRET: placeholder,
          WORKEROS_API_BASE: "https://workers-api.floom.dev",
        },
      },
    },
  }, null, 2);
  return [
    "No supported MCP client config was found.",
    "Create one of these files and add:",
    "- ~/.claude/settings.json",
    "- ~/.cursor/mcp.json",
    "- ~/.continue/.continuerc.json",
    "",
    objectSnippet,
  ].join("\n");
}

function selectClients(target?: ClientTarget): Array<(typeof CLIENTS)[number]> {
  if (target) return CLIENTS.filter((client) => client.target === target);
  return [...CLIENTS];
}

export async function mcpInstallCommand(options: { target?: ClientTarget }): Promise<number> {
  const home = resolveHomeDir();
  if (!home) throw new Error("HOME is required");

  const credentials = await readCredentials();
  const fallbackSecret = process.env.WORKEROS_API_SECRET?.trim();
  const resolvedSecret = credentials?.api_secret || fallbackSecret;
  const resolvedBase = credentials?.api_base || process.env.WORKEROS_API_BASE || "https://workers-api.floom.dev";
  if (!resolvedSecret) {
    throw new Error("Not logged in. Run floom login first.");
  }

  const candidates = selectClients(options.target);
  for (const client of candidates) {
    const path = join(home, client.path);
    if (!options.target && !existsSync(path)) {
      continue;
    }
    const config = readJson(path);
    const patched = client.kind === "array"
      ? patchContinueConfig(config, resolvedSecret, resolvedBase)
      : patchObjectConfig(config, resolvedSecret, resolvedBase);
    await writeJson(path, patched);
    console.log(`Installed Workeros MCP config for ${client.name} at ~/${client.path}`);
    return 0;
  }

  console.log(manualSnippets());
  return 0;
}

export async function mcpUninstallCommand(options: { target?: ClientTarget }): Promise<number> {
  const home = resolveHomeDir();
  if (!home) throw new Error("HOME is required");
  const candidates = selectClients(options.target);
  for (const client of candidates) {
    const path = join(home, client.path);
    if (!existsSync(path)) continue;
    const config = readJson(path);
    const patched = client.kind === "array" ? removeContinueConfig(config) : removeObjectConfig(config);
    await writeJson(path, patched);
    console.log(`Removed Workeros MCP config from ${client.name} at ~/${client.path}`);
    return 0;
  }
  console.log("No Workeros MCP config entries were found.");
  return 0;
}
