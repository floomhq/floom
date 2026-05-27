import { clearCredentials } from "../lib/credentials.js";

export async function runLogoutCommand(): Promise<number> {
  const removed = await clearCredentials();
  if (removed) {
    console.log("Logged out.");
  } else {
    console.log("No saved credentials were found.");
  }
  return 0;
}
