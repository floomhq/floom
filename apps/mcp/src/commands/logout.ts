import { clearCredentials } from "../lib/credentials.js";
import { getCommandName } from "../lib/command-name.js";
import { log } from "../lib/output.js";

export async function runLogoutCommand(): Promise<number> {
  const removed = await clearCredentials();
  if (removed) {
    log.ok("Logged out.");
  } else {
    log.warn("No saved credentials were found.");
    log.info(`Run: ${getCommandName()} login to authenticate`);
  }
  return 0;
}
