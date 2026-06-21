import { createAuthenticatedClient, FloomApiError } from "../lib/api.js";
import { getCommandName } from "../lib/command-name.js";
import { promptHidden, promptYesNo } from "../lib/prompt.js";
import { log, printJson, renderTable } from "../lib/output.js";

type SecretItem = { name: string; status: string };

const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

function handleAuthError(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Not logged in")) {
    log.err("Not authenticated.");
    process.stderr.write(`Run: ${getCommandName()} login\n`);
    return 1;
  }
  if (error instanceof FloomApiError && (error.status === 401 || error.status === 403)) {
    log.err("Your session expired.");
    process.stderr.write(`Re-run: ${getCommandName()} login\n`);
    return 1;
  }
  if (error instanceof FloomApiError && error.status && error.status >= 500) {
    log.err(`API error: ${message}`);
    process.stderr.write("Check API status, then retry. Report: https://github.com/floomhq/floom/issues\n");
    return 1;
  }
  return null;
}

export async function secretsListCommand(options: { json?: boolean }): Promise<number> {
  try {
    const { client } = await createAuthenticatedClient();
    const secrets = (await client.requestJson("GET", "/secrets")) as SecretItem[];
    if (options.json) {
      printJson(secrets);
      return 0;
    }
    if (!secrets.length) {
      log.info("No secrets stored.");
      log.info(`Add one: ${getCommandName()} secrets set MY_SECRET`);
      return 0;
    }
    process.stdout.write(renderTable(
      secrets.map((secret) => ({ name: secret.name })),
      [{ key: "name", label: "Name" }],
    ) + "\n");
    return 0;
  } catch (error) {
    const handled = handleAuthError(error);
    if (handled !== null) return handled;
    throw error;
  }
}

export async function secretsSetCommand(key: string, options: { value?: string } = {}): Promise<number> {
  if (!SECRET_NAME_PATTERN.test(key)) {
    log.err(`Invalid secret name: '${key}'`);
    log.info("Use UPPER_SNAKE_CASE (e.g., GITHUB_PAT)");
    return 1;
  }
  try {
    const { client } = await createAuthenticatedClient();
    const value = options.value ?? await promptHidden(`Value for ${key}: `);
    if (!value) {
      log.err("Secret value cannot be empty.");
      log.info(`Run: ${getCommandName()} secrets set ${key} --value <value>`);
      return 1;
    }
    await client.requestJson("POST", `/secrets/${encodeURIComponent(key)}`, { body: { value } });
    log.ok(`Saved ${key}`);
    return 0;
  } catch (error) {
    const handled = handleAuthError(error);
    if (handled !== null) return handled;
    throw error;
  }
}

export async function secretsDeleteCommand(key: string, options: { yes?: boolean }): Promise<number> {
  try {
    const { client } = await createAuthenticatedClient();
    const confirmed = options.yes || await promptYesNo(`Delete secret ${key}? [y/N] `, false);
    if (!confirmed) {
      log.info("Cancelled.");
      return 0;
    }
    await client.requestJson("DELETE", `/secrets/${encodeURIComponent(key)}`);
    log.ok(`Deleted ${key}`);
    return 0;
  } catch (error) {
    if (error instanceof FloomApiError && error.status === 404) {
      log.err(`Secret '${key}' not found.`);
      log.info(`List available secrets: ${getCommandName()} secrets list`);
      return 1;
    }
    const handled = handleAuthError(error);
    if (handled !== null) return handled;
    throw error;
  }
}
