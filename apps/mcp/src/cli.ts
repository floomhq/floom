#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { main as runServer } from "./server.js";

type JsonObject = Record<string, unknown>;

const PACKAGE_NAME = "@floomhq/workeros";
const SERVER_ENTRY = {
  command: "npx",
  args: ["-y", PACKAGE_NAME],
};

const CLIENTS = [
  { name: "Claude Code", path: ".claude/settings.json", kind: "object" },
  { name: "Cursor", path: ".cursor/mcp.json", kind: "object" },
  { name: "Continue", path: ".continue/.continuerc.json", kind: "array" },
] as const;

function homeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || "";
}

function serverConfig(secret: string): JsonObject {
  return {
    ...SERVER_ENTRY,
    env: {
      WORKEROS_API_SECRET: secret,
    },
  };
}

function readJson(path: string): JsonObject {
  if (!existsSync(path)) {
    return {};
  }
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw) as JsonObject;
}

function writeJson(path: string, value: JsonObject): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function patchObjectConfig(config: JsonObject, secret: string): JsonObject {
  const next = { ...config };
  const mcpServers = typeof next.mcpServers === "object" && next.mcpServers && !Array.isArray(next.mcpServers)
    ? { ...(next.mcpServers as JsonObject) }
    : {};
  mcpServers.workeros = serverConfig(secret);
  next.mcpServers = mcpServers;
  return next;
}

function patchContinueConfig(config: JsonObject, secret: string): JsonObject {
  const next = { ...config };
  const servers = Array.isArray(next.mcpServers) ? [...next.mcpServers] : [];
  const entry = {
    name: "workeros",
    ...serverConfig(secret),
  };
  const existingIndex = servers.findIndex((server) => (
    typeof server === "object" && server !== null && (server as JsonObject).name === "workeros"
  ));
  if (existingIndex === -1) {
    servers.push(entry);
  } else {
    servers[existingIndex] = entry;
  }
  next.mcpServers = servers;
  return next;
}

function manualSnippets(): string {
  const placeholder = "<WORKEROS_API_SECRET>";
  const objectSnippet = JSON.stringify({ mcpServers: { workeros: serverConfig(placeholder) } }, null, 2);
  const continueSnippet = JSON.stringify({ mcpServers: [{ name: "workeros", ...serverConfig(placeholder) }] }, null, 2);
  return [
    "No supported agent config file was found.",
    "",
    "Create or update one of these files:",
    "- Claude Code: ~/.claude/settings.json",
    "- Cursor: ~/.cursor/mcp.json",
    "- Continue: ~/.continue/.continuerc.json",
    "",
    "Claude Code / Cursor:",
    objectSnippet,
    "",
    "Continue:",
    continueSnippet,
  ].join("\n");
}

async function resolveSecret(): Promise<string> {
  if (process.env.WORKEROS_API_SECRET) {
    return process.env.WORKEROS_API_SECRET;
  }
  const rl = createInterface({ input, output });
  try {
    const secret = await rl.question("WORKEROS_API_SECRET: ");
    if (!secret.trim()) {
      throw new Error("WORKEROS_API_SECRET is required");
    }
    return secret.trim();
  } finally {
    rl.close();
  }
}

async function install(): Promise<void> {
  const home = homeDir();
  if (!home) {
    throw new Error("HOME is required to locate agent config files");
  }

  const secret = await resolveSecret();
  for (const client of CLIENTS) {
    const path = join(home, client.path);
    if (!existsSync(path)) {
      continue;
    }
    const config = readJson(path);
    const patched = client.kind === "array" ? patchContinueConfig(config, secret) : patchObjectConfig(config, secret);
    writeJson(path, patched);
    console.log(`Installed Workeros MCP config for ${client.name} at ~/${client.path}`);
    return;
  }

  console.log(manualSnippets());
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const command = argv[0];
  if (!command) {
    await runServer();
    return;
  }
  if (command === "install") {
    await install();
    return;
  }

  console.log("Usage: workeros install");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`workeros failed: ${message}`);
  process.exit(1);
});
