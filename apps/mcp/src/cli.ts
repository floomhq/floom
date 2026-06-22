#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { Command } from "commander";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { runLoginCommand } from "./commands/login.js";
import { runLogoutCommand } from "./commands/logout.js";
import { runWhoamiCommand } from "./commands/whoami.js";
import { runWorkerCommand } from "./commands/run.js";
import {
  workersListCommand,
  workersShowCommand,
  workersInfoCommand,
  workersPushCommand,
  workersValidateCommand,
} from "./commands/workers.js";
import {
  workspacesCreateCommand,
  workspacesListCommand,
  workspacesShowCommand,
  workspacesSwitchCommand,
} from "./commands/workspaces.js";
import {
  runsApproveCommand,
  runsCancelCommand,
  runsDownloadCommand,
  runsListCommand,
  runsLogsCommand,
  runsRejectCommand,
  runsShowCommand,
} from "./commands/runs.js";
import {
  secretsDeleteCommand,
  secretsListCommand,
  secretsSetCommand,
} from "./commands/secrets.js";
import {
  connectionsAddCommand,
  connectionsImportMcpConfigCommand,
  connectionsListCommand,
} from "./commands/connections.js";
import {
  mcpInstallCommand,
  mcpListCommand,
  mcpSwitchCommand,
  mcpTestCommand,
  mcpUninstallCommand,
} from "./commands/mcp.js";
import { completionCommand } from "./commands/completion.js";
import { doctorCommand } from "./commands/doctor.js";
import { main as runServer } from "./server.js";
import {
  type CommandName,
  getCommandName,
  resolveCommandName,
  setCommandName,
} from "./lib/command-name.js";

type RunResult = Promise<number> | number;

export function getPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const packageJsonPath = join(here, "..", "package.json");
  const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: string };
  return parsed.version || "0.0.0";
}

async function runAction(result: RunResult): Promise<void> {
  const code = await result;
  if (code !== 0) {
    process.exitCode = code;
  }
}

export function buildCliProgram(commandName: CommandName = "floom"): Command {
  const program = new Command();
  program
    .name(commandName)
    .description("Floom CLI")
    .version(getPackageVersion())
    .showHelpAfterError()
    // OSS/self-hosted: identity sent as x-floom-user (engines with user-header
    // scope require it). Also settable via WORKEROS_USER / FLOOM_USER.
    .option("--user <user>", "OSS self-hosted: send x-floom-user header");

  // A global --user must reach readCredentials(), which reads from env. Mirror
  // the flag into WORKEROS_USER before any subcommand action runs.
  program.hook("preSubcommand", (thisCommand) => {
    const user = thisCommand.opts().user;
    if (typeof user === "string" && user.trim()) {
      process.env.WORKEROS_USER = user.trim();
    }
  });

  program.command("login")
    .description("Login via browser device authorization")
    .option("--cloud", "Authenticate against a hosted Floom instance")
    .action(async (options: { cloud?: boolean }) => runAction(runLoginCommand(options)));

  program.command("logout")
    .description("Remove saved CLI credentials")
    .action(async () => runAction(runLogoutCommand()));

  program.command("whoami")
    .description("Show current auth identity")
    .option("--json", "Print raw JSON")
    .action(async (options: { json?: boolean }) => runAction(runWhoamiCommand(options)));

  program.command("run")
    .description("Start and monitor a worker run")
    .argument("<id>", "Worker id")
    .option("--input <key=value>", "Input key/value (repeatable)", (value: string, acc: string[]) => [...acc, value], [])
    .option("-f, --inputs-file <path>", "Path to JSON inputs object")
    .option("--output-dir <path>", "Save artifacts to this directory")
    .option("--json", "Print final run JSON")
    .action(async (
      id: string,
      options: { input?: string[]; inputsFile?: string; outputDir?: string; json?: boolean },
    ) => runAction(runWorkerCommand(id, options)));

  const workers = program.command("workers").description("List or inspect workers");
  workers.command("list")
    .description("List workers")
    .option("--json", "Print raw JSON")
    .action(async (options: { json?: boolean }) => runAction(workersListCommand(options)));
  workers.command("show")
    .description("Show a worker")
    .argument("<id>", "Worker id")
    .option("--json", "Print raw JSON")
    .action(async (id: string, options: { json?: boolean }) => runAction(workersShowCommand(id, options)));
  workers.command("info")
    .description("Pretty single-worker summary (description, trigger, connections, last run)")
    .argument("<id>", "Worker id")
    .option("--json", "Print raw JSON")
    .action(async (id: string, options: { json?: boolean }) => runAction(workersInfoCommand(id, options)));
  workers.command("validate")
    .description("Validate a local worker directory")
    .argument("<dir>", "Directory containing worker.yml plus run.py or SKILL.md")
    .action(async (dir: string) => runAction(workersValidateCommand(dir)));
  workers.command("push")
    .description("Create or update a worker from a local worker directory")
    .argument("<dir>", "Directory containing worker.yml plus run.py or SKILL.md")
    .action(async (dir: string) => runAction(workersPushCommand(dir)));
  workers.command("run")
    .description(`Trigger a worker run (alias for \`${commandName} run\`)`)
    .argument("<id>", "Worker id")
    .option("--input <key=value>", "Input key/value (repeatable)", (value: string, acc: string[]) => [...acc, value], [])
    .option("-f, --inputs-file <path>", "Path to JSON inputs object")
    .option("--output-dir <path>", "Save artifacts to this directory")
    .option("--json", "Print final run JSON")
    .action(async (
      id: string,
      options: { input?: string[]; inputsFile?: string; outputDir?: string; json?: boolean },
    ) => runAction(runWorkerCommand(id, options)));

  const workspaces = program.command("workspaces")
    .alias("workspace")
    .description("Manage workspaces");
  workspaces.command("list")
    .description("List workspaces your credentials can access")
    .option("--json", "Print raw JSON")
    .action(async (options: { json?: boolean }) => runAction(workspacesListCommand(options)));
  workspaces.command("create")
    .description("Create a workspace and make it active")
    .argument("<name>", "Workspace name")
    .option("--json", "Print raw JSON")
    .action(async (name: string, options: { json?: boolean }) => runAction(workspacesCreateCommand(name, options)));
  workspaces.command("show")
    .description("Show the currently active workspace")
    .option("--json", "Print raw JSON")
    .action(async (options: { json?: boolean }) => runAction(workspacesShowCommand(options)));
  workspaces.command("switch")
    .alias("use")
    .description("Switch the active workspace (matches by name or id; requires authenticated access)")
    .argument("<name-or-id>", "Workspace name or id")
    .action(async (target: string) => runAction(workspacesSwitchCommand(target)));

  const runs = program.command("runs").description("Inspect worker runs");
  runs.command("list")
    .description("List runs")
    .option("--worker <id>", "Filter by worker id")
    .option("--status <status>", "Filter by run status")
    .option("--limit <n>", "Number of rows", (value: string) => Number(value), 20)
    .option("--json", "Print raw JSON")
    .action(async (options: { worker?: string; status?: string; limit?: number; json?: boolean }) =>
      runAction(runsListCommand(options)));
  runs.command("show")
    .description("Show run details")
    .argument("<id>", "Run id")
    .option("--json", "Print raw JSON")
    .action(async (id: string, options: { json?: boolean }) => runAction(runsShowCommand(id, options)));
  runs.command("logs")
    .description("Show run logs")
    .argument("<id>", "Run id")
    .option("-f, --follow", "Follow live run events")
    .action(async (id: string, options: { follow?: boolean }) => runAction(runsLogsCommand(id, options)));
  runs.command("download")
    .description("Download run bundle archive")
    .argument("<id>", "Run id")
    .action(async (id: string) => runAction(runsDownloadCommand(id)));
  runs.command("approve")
    .description("Approve a pending approval run")
    .argument("<id>", "Run id")
    .option("--comment <text>", "Optional approval comment")
    .option("--edit <json>", "Edited output JSON to approve with")
    .option("--json", "Print raw JSON")
    .action(async (id: string, options: { comment?: string; edit?: string; json?: boolean }) =>
      runAction(runsApproveCommand(id, options)));
  runs.command("reject")
    .description("Reject a pending approval run")
    .argument("<id>", "Run id")
    .option("--reason <text>", "Rejection reason")
    .option("--json", "Print raw JSON")
    .action(async (id: string, options: { reason?: string; json?: boolean }) =>
      runAction(runsRejectCommand(id, options)));
  runs.command("cancel")
    .description("Cancel a queued or running run")
    .argument("<id>", "Run id")
    .option("--json", "Print raw JSON")
    .action(async (id: string, options: { json?: boolean }) =>
      runAction(runsCancelCommand(id, options)));

  const secrets = program.command("secrets").description("Manage secrets");
  secrets.command("list")
    .description("List secret names")
    .option("--json", "Print raw JSON")
    .action(async (options: { json?: boolean }) => runAction(secretsListCommand(options)));
  secrets.command("set")
    .description("Set a secret value")
    .argument("<key>", "Secret name")
    .option("--value <value>", "Secret value for non-interactive automation")
    .action(async (key: string, options: { value?: string }) => runAction(secretsSetCommand(key, options)));
  secrets.command("delete")
    .description("Delete a secret")
    .argument("<key>", "Secret name")
    .option("-y, --yes", "Skip confirmation")
    .action(async (key: string, options: { yes?: boolean }) => runAction(secretsDeleteCommand(key, options)));

  const connections = program.command("connections").description("Manage app and MCP connections");
  connections.command("list")
    .description("List saved connections")
    .option("--json", "Print raw JSON")
    .action(async (options: { json?: boolean }) => runAction(connectionsListCommand(options)));
  connections.command("add")
    .description("Start OAuth for an app connection")
    .argument("<app>", "App/toolkit slug, for example gmail, github, googlecalendar")
    .option("--open", "Open the authorization URL in a browser")
    .option("--json", "Print raw JSON")
    .action(async (app: string, options: { json?: boolean; open?: boolean }) =>
      runAction(connectionsAddCommand(app, options)));
  connections.command("import-mcp-config")
    .description("Import MCP servers from a Claude/Cursor/VS Code mcpServers JSON file")
    .argument("<path>", "Path to MCP client config JSON")
    .option("--json", "Print raw JSON")
    .action(async (path: string, options: { json?: boolean }) =>
      runAction(connectionsImportMcpConfigCommand(path, options)));

  const mcp = program.command("mcp").description("Manage MCP servers and client config");
  mcp.command("list")
    .description("List configured MCP servers and mark the active one")
    .option("--json", "Print raw JSON")
    .action(async (options: { json?: boolean }) => runAction(mcpListCommand(options)));
  mcp.command("switch")
    .description("Switch the active MCP server (matches by label)")
    .argument("<name>", "MCP server label")
    .action(async (target: string) => runAction(mcpSwitchCommand(target)));
  mcp.command("test")
    .description("Probe an MCP server (initialize + tools/list); defaults to the active one")
    .argument("[name]", "MCP server label (defaults to the active server)")
    .option("--json", "Print raw JSON")
    .action(async (target: string | undefined, options: { json?: boolean }) =>
      runAction(mcpTestCommand(target, options)));
  mcp.command("add")
    .description("Add Floom to an MCP client config")
    .option("--target <target>", "claude | cursor | vscode | windsurf | continue | generic")
    .action(async (options: { target?: "claude" | "cursor" | "vscode" | "windsurf" | "continue" | "generic" }) =>
      runAction(mcpInstallCommand(options)));
  mcp.command("install")
    .description("Install MCP config for a client")
    .option("--target <target>", "claude | cursor | vscode | windsurf | continue | generic")
    .action(async (options: { target?: "claude" | "cursor" | "vscode" | "windsurf" | "continue" | "generic" }) =>
      runAction(mcpInstallCommand(options)));
  mcp.command("uninstall")
    .description("Remove MCP config for a client")
    .option("--target <target>", "claude | cursor | vscode | windsurf | continue | generic")
    .action(async (options: { target?: "claude" | "cursor" | "vscode" | "windsurf" | "continue" | "generic" }) =>
      runAction(mcpUninstallCommand(options)));

  program.command("completion")
    .description("Print shell completion script")
    .argument("<shell>", "bash | zsh | fish")
    .action(async (shell: "bash" | "zsh" | "fish") => {
      if (!["bash", "zsh", "fish"].includes(shell)) {
        throw new Error("Shell must be one of: bash, zsh, fish");
      }
      await runAction(completionCommand(shell));
    });

  program.command("install")
    .description("Install MCP config (deprecated alias for mcp install)")
    .action(async () => runAction(mcpInstallCommand({})));

  program.command("doctor")
    .description("Check CLI setup: API reachable, auth valid, MCP installed, runs endpoint working")
    .option("--json", "Print raw JSON")
    .action(async (options: { json?: boolean }) => runAction(doctorCommand(options)));

  return program;
}

export async function main(argv = process.argv): Promise<void> {
  const commandName = resolveCommandName(argv);
  setCommandName(commandName);
  const program = buildCliProgram(commandName);
  const args = argv.slice(2);
  if (args.length === 0) {
    // MCP clients launch the server with a piped stdin (no TTY). A human running
    // the bare command in a terminal instead gets help and a non-zero exit,
    // rather than a silently-hanging stdio server.
    if (process.stdin.isTTY) {
      program.outputHelp();
      process.exitCode = 1;
      return;
    }
    await runServer();
    return;
  }
  await program.parseAsync(argv);
}

function resolveExecutedPath(argv1?: string): string {
  if (!argv1) return "";
  const absolute = resolve(argv1);
  // npm installs bins as symlinks (node_modules/.bin/floom -> ../@floomhq/floom/dist/cli.js).
  // import.meta.url is always the real module path, so compare against the resolved symlink target.
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

const executedPath = resolveExecutedPath(process.argv[1]);
if (executedPath && fileURLToPath(import.meta.url) === executedPath) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${getCommandName()} failed: ${message}`);
    process.exit(1);
  });
}
