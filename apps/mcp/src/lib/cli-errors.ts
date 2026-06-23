import { FloomApiError } from "./api.js";
import { getCommandName } from "./command-name.js";
import { log } from "./output.js";

// Maps auth failures to a friendly message + exit code 1; returns null for
// everything else so callers can rethrow.
export function handleAuthError(error: unknown): number | null {
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
  return null;
}
