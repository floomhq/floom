import open from "open";
import { createPublicClient, WorkerosApiError } from "../lib/api.js";
import { promptYesNo } from "../lib/prompt.js";
import { log } from "../lib/output.js";
import { writeCredentials, credentialsPath } from "../lib/credentials.js";

type DeviceResponse = {
  device_code: string;
  user_code: string;
  verification_url: string;
  polling_interval_seconds: number;
  expires_in_seconds: number;
};

type PollPending = { status: "pending" };
type PollApproved = { status: "approved"; api_secret: string; api_base: string };
type PollResponse = PollPending | PollApproved;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runLoginCommand(): Promise<number> {
  log.heading("Login");
  log.step("Requesting device authorization...");

  const client = createPublicClient();
  const started = (await client.requestJson("POST", "/cli-auth/devices", {
    auth: false,
    body: { client_name: "floom-cli", scopes: [] },
  })) as DeviceResponse;

  log.ok(`Open: ${started.verification_url}`);
  const shouldOpen = await promptYesNo("Or open the URL automatically? [Y/n] ", true);
  if (shouldOpen) {
    try {
      await open(started.verification_url);
    } catch {
      // Best effort only.
    }
  }

  log.step("Waiting for approval... (Ctrl+C to cancel)");

  const deadline = Date.now() + started.expires_in_seconds * 1000;
  while (Date.now() < deadline) {
    try {
      const polled = (await client.requestJson(
        "GET",
        `/cli-auth/poll/${encodeURIComponent(started.device_code)}`,
        { auth: false },
      )) as PollResponse;
      if (polled.status === "pending") {
        await sleep(started.polling_interval_seconds * 1000);
        continue;
      }
      if (polled.status === "approved") {
        const authedAt = new Date().toISOString();
        await writeCredentials({
          api_base: polled.api_base,
          api_secret: polled.api_secret,
          authed_at: authedAt,
        });
        const credsPath = credentialsPath();
        log.ok(`Logged in`);
        log.kv("API", polled.api_base);
        log.kv("Token saved to", credsPath);
        log.blank();
        log.info("Try: floom workers list");
        return 0;
      }
      await sleep(started.polling_interval_seconds * 1000);
    } catch (error) {
      if (error instanceof WorkerosApiError) {
        if (error.status === 403) {
          log.err("CLI authorization was denied.");
          log.info("Run: floom login to try again");
          return 1;
        }
        if (error.status === 410) {
          log.err("Device code expired before approval.");
          log.info("Run: floom login to start a new session");
          return 1;
        }
        if (error.status === 404) {
          log.err("Device code not found.");
          log.info("Run: floom login to start a new session");
          return 1;
        }
      }
      throw error;
    }
  }
  log.err("Timed out waiting for CLI approval.");
  log.info("Run: floom login to try again");
  return 1;
}
