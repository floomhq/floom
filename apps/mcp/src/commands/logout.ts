import { clearCredentials } from "../lib/credentials.js";
import { log } from "../lib/output.js";

export async function runLogoutCommand(): Promise<number> {
  const removed = await clearCredentials();
  if (removed) {
    log.ok("Logged out.");
  } else {
    log.warn("No saved credentials were found.");
    log.info("Run: floom login to authenticate");
  }
  return 0;
}
