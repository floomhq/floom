import { runLoginCommand } from "./login.js";
import { runWhoamiCommand } from "./whoami.js";
import {
  listCredentialAccounts,
  removeCredentialAccount,
  switchCredentialAccount,
} from "../lib/credentials.js";
import { getCommandName } from "../lib/command-name.js";
import { log, printJson } from "../lib/output.js";

export async function authListCommand(options: { json?: boolean } = {}): Promise<number> {
  const accounts = await listCredentialAccounts();
  if (options.json) {
    printJson({ accounts });
    return 0;
  }
  if (!accounts.length) {
    log.warn("No saved accounts.");
    log.info(`Run: ${getCommandName()} auth login`);
    return 0;
  }
  log.heading("Saved Accounts");
  for (const account of accounts) {
    const marker = account.active ? "*" : " ";
    const workspace = account.workspace_name || account.workspace_id || "no workspace";
    log.info(`${marker} ${account.label} (${account.id})`);
    log.info(`  ${account.mode} · ${workspace} · ${account.api_base}`);
  }
  return 0;
}

export async function authSwitchCommand(target: string): Promise<number> {
  try {
    const creds = await switchCredentialAccount(target);
    log.ok(`Active account set to ${creds.account_label || creds.account_id || target}.`);
    if (creds.workspace_name || creds.workspace_id) {
      log.kv("Workspace", creds.workspace_name || creds.workspace_id || "");
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.err(message);
    log.info(`Run: ${getCommandName()} auth list`);
    return 1;
  }
}

export async function authLogoutCommand(target?: string): Promise<number> {
  const removed = await removeCredentialAccount(target);
  if (removed) {
    log.ok(target ? `Removed saved account ${target}.` : "Logged out.");
  } else {
    log.warn(target ? `No saved account matched ${target}.` : "No saved credentials were found.");
    log.info(`Run: ${getCommandName()} auth login to authenticate`);
  }
  return 0;
}

export const authLoginCommand = runLoginCommand;
export const authStatusCommand = runWhoamiCommand;
