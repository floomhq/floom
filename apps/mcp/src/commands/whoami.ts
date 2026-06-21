import { createAuthenticatedClient } from "../lib/api.js";
import { maskSecret } from "../lib/credentials.js";
import { log, printJson } from "../lib/output.js";

export async function runWhoamiCommand(options: { json?: boolean } = {}): Promise<number> {
  try {
    const { client, credentials } = await createAuthenticatedClient();
    // /system/info lives on the engine app. In cloud the engine is mounted
    // under /api, so cloud-mode whoami needs the /api prefix.
    const path = credentials.mode === "cloud" ? "/api/system/info" : "/system/info";
    const info = await client.requestJson("GET", path);
    const payload: Record<string, unknown> = {
      mode: credentials.mode,
      api_base: credentials.api_base,
      authed_at: credentials.authed_at,
      system_info: info,
    };
    if (credentials.mode === "cloud") {
      payload.workspace_id = credentials.workspace_id || null;
      payload.workspace_name = credentials.workspace_name || null;
      if (credentials.api_token) {
        payload.api_token_masked = maskSecret(credentials.api_token);
      } else {
        payload.refresh_token_masked = maskSecret(credentials.refresh_token || "");
      }
    } else {
      payload.api_secret_masked = maskSecret(credentials.api_secret || "");
      payload.user = credentials.user || null;
    }
    if (options.json) {
      printJson(payload);
    } else {
      log.heading("Identity");
      log.kv("Mode", credentials.mode);
      log.kv("API base", credentials.api_base);
      const ws = credentials.workspace_name || credentials.workspace_id;
      log.kv("Workspace", ws ? ws : "(none, run `floom workspace switch <name>`)");
      if (credentials.mode === "cloud") {
        if (credentials.api_token) {
          log.kv("API token", maskSecret(credentials.api_token));
        } else {
          log.kv("Refresh token", maskSecret(credentials.refresh_token || ""));
        }
      } else {
        log.kv("API secret", maskSecret(credentials.api_secret || ""));
        if (credentials.user) {
          log.kv("User", credentials.user);
        }
      }
      log.kv("Authed at", credentials.authed_at);
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
