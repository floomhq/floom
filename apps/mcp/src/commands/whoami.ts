import { createAuthenticatedClient } from "../lib/api.js";
import { maskSecret } from "../lib/credentials.js";
import { printJson } from "../lib/output.js";

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
      console.log(`API base: ${payload.api_base}`);
      console.log(`API secret: ${payload.api_secret_masked}`);
      console.log(`Authed at: ${payload.authed_at}`);
      console.log(`System info: ok`);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Not logged in")) {
      console.error("Not logged in. Run floom login first.");
      return 1;
    }
    throw error;
  }
}
