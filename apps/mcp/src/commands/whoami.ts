import { createAuthenticatedClient } from "../lib/api.js";
import { maskSecret } from "../lib/credentials.js";
import { log, printJson } from "../lib/output.js";

export async function runWhoamiCommand(options: { json?: boolean } = {}): Promise<number> {
  try {
    const { client, credentials } = await createAuthenticatedClient();
    const info = await client.requestJson("GET", "/system/info");
    const payload = {
      api_base: credentials.api_base,
      api_secret_masked: maskSecret(credentials.api_secret),
      authed_at: credentials.authed_at,
      system_info: info,
    };
    if (options.json) {
      printJson(payload);
    } else {
      log.heading("Identity");
      log.kv("API base", payload.api_base);
      log.kv("API secret", payload.api_secret_masked);
      log.kv("Authed at", payload.authed_at);
      log.ok("System reachable");
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Not logged in")) {
      log.err("Not logged in.");
      log.info("Run: floom login");
      return 1;
    }
    throw error;
  }
}
