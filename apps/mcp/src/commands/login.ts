import open from "open";
import { createPublicClient, WorkerosApiError } from "../lib/api.js";
import { promptYesNo } from "../lib/prompt.js";
import { ok } from "../lib/output.js";
import { writeCredentials } from "../lib/credentials.js";

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
  const client = createPublicClient();
  const started = (await client.requestJson("POST", "/cli-auth/devices", {
    auth: false,
    body: { client_name: "floom-cli", scopes: [] },
  })) as DeviceResponse;

  console.log(`Visit ${started.verification_url} and approve.`);
  const shouldOpen = await promptYesNo("Or open the URL automatically? [Y/n] ", true);
  if (shouldOpen) {
    try {
      await open(started.verification_url);
    } catch {
      // Best effort only.
    }
  }

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
        console.log(ok(`✓ Logged in to ${polled.api_base}`));
        return 0;
      }
      await sleep(started.polling_interval_seconds * 1000);
    } catch (error) {
      if (error instanceof WorkerosApiError) {
        if (error.status === 403) {
          throw new Error("CLI authorization was denied.");
        }
        if (error.status === 410) {
          throw new Error("Device code expired before approval.");
        }
        if (error.status === 404) {
          throw new Error("Device code not found. Start login again.");
        }
      }
      throw error;
    }
  }
  throw new Error("Timed out waiting for CLI approval.");
}
