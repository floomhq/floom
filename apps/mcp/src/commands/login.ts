import open from "open";
import {
  WorkerosApiClient,
  WorkerosApiError,
  resolveLoginApiBase,
} from "../lib/api.js";
import { promptYesNo } from "../lib/prompt.js";
import { log } from "../lib/output.js";
import {
  writeCredentials,
  credentialsPath,
  type StoredCredentials,
} from "../lib/credentials.js";

type DeviceResponse = {
  device_code: string;
  user_code: string;
  verification_url: string;
  polling_interval_seconds: number;
  expires_in_seconds: number;
};

type OssPollPending = { status: "pending" };
type OssPollApproved = { status: "approved"; api_secret: string; api_base: string };
type OssPollResponse = OssPollPending | OssPollApproved;

type CloudExchangeResponse = {
  refresh_token: string;
  expires_in_seconds: number;
  user_id?: string;
  supabase_url?: string;
  supabase_anon_key?: string;
  api_base?: string;
};

type CloudBootstrap = {
  supabase_url: string;
  supabase_anon_key: string;
  api_base?: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterSecondsFromBody(body: unknown): number | null {
  if (!body || typeof body !== "object") return null;
  const detail = "detail" in body ? (body as { detail?: unknown }).detail : undefined;
  if (!detail || typeof detail !== "object") return null;
  const retryAfter = (detail as { retry_after?: unknown }).retry_after;
  if (typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter > 0) {
    return retryAfter;
  }
  if (typeof retryAfter === "string") {
    const parsed = Number(retryAfter);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function retryAfterSecondsFromHeader(headers: Headers | undefined): number | null {
  const raw = headers?.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) return seconds;
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) {
    return Math.max(1, Math.ceil((dateMs - Date.now()) / 1000));
  }
  return null;
}

export function cloudRateLimitRetryMs(
  error: WorkerosApiError,
  pollingIntervalSeconds: number,
): number {
  const retryAfterSeconds =
    retryAfterSecondsFromHeader(error.headers) ?? retryAfterSecondsFromBody(error.body);
  const fallbackSeconds = Math.max(pollingIntervalSeconds, 5);
  return Math.ceil((retryAfterSeconds ?? fallbackSeconds) * 1000);
}

export type LoginOptions = {
  cloud?: boolean;
};

// Heuristic: the cloud verification_url points at workeros.example.com
// (or /app/cli-auth). The OSS engine points at localhost:3000/cli-auth.
// Lets the CLI auto-detect cloud-vs-oss even when --cloud is omitted, so a
// user running `floom login` against WORKEROS_API_BASE=<cloud> still gets
// the right flow.
function detectCloudFromVerificationUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.hostname === "workeros.example.com") return true;
    if (u.pathname.startsWith("/app/")) return true;
    return false;
  } catch {
    return false;
  }
}

async function fetchCloudBootstrap(apiBase: string): Promise<CloudBootstrap | null> {
  // Optional: cloud may expose /auth/cli-bootstrap to hand the CLI the
  // Supabase project URL + anon key it needs to refresh JWTs. If absent,
  // the cli-exchange response carries the same fields and we still succeed.
  try {
    const response = await fetch(`${apiBase}/auth/cli-bootstrap`, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) return null;
    const parsed = (await response.json()) as Partial<CloudBootstrap>;
    if (parsed.supabase_url && parsed.supabase_anon_key) {
      return {
        supabase_url: parsed.supabase_url,
        supabase_anon_key: parsed.supabase_anon_key,
        api_base: parsed.api_base,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export async function runLoginCommand(options: LoginOptions = {}): Promise<number> {
  log.heading("Login");
  log.step("Requesting device authorization...");

  const loginApiBase = resolveLoginApiBase(options);
  const client = new WorkerosApiClient(loginApiBase);
  // The engine endpoint /cli-auth/devices lives at /api/cli-auth/devices
  // when the cloud FastAPI app mounts the engine under /api. We don't have
  // saved credentials yet, so resolvePath in the client can't help. Probe
  // the hosted path first when --cloud (or WORKEROS_CLOUD=1) is set;
  // otherwise default to the OSS path.
  const explicitCloud =
    options.cloud === true ||
    (process.env.WORKEROS_CLOUD || "").trim() === "1" ||
    (process.env.WORKEROS_CLOUD || "").trim().toLowerCase() === "true";
  const devicesPath = explicitCloud ? "/api/cli-auth/devices" : "/cli-auth/devices";
  const pollPathPrefix = explicitCloud ? "/api/cli-auth/poll" : "/cli-auth/poll";
  const started = (await client.requestJson("POST", devicesPath, {
    auth: false,
    body: { client_name: "floom-cli", scopes: [] },
  })) as DeviceResponse;

  log.ok(`Open: ${started.verification_url}`);
  // Anti-phishing: show the user_code prominently and tell the user to verify
  // it matches the code on the approval page. A device flow approval can be
  // phished (an attacker starts a flow and tricks the owner into approving it),
  // so the only safe approval is one where the code on screen equals the code
  // shown HERE, in the terminal the user actually started.
  log.heading(`Verification code: ${started.user_code}`);
  log.warn(
    "Approve ONLY if this exact code appears on the page. " +
      "If it differs, someone may be trying to hijack your login — deny it.",
  );
  const shouldOpen = await promptYesNo("Or open the URL automatically? [Y/n] ", true);
  if (shouldOpen) {
    try {
      await open(started.verification_url);
    } catch {
      // Best effort only.
    }
  }

  const isCloud =
    options.cloud === true || detectCloudFromVerificationUrl(started.verification_url);

  log.step("Waiting for approval... (Ctrl+C to cancel)");

  const deadline = Date.now() + started.expires_in_seconds * 1000;
  while (Date.now() < deadline) {
    try {
      if (isCloud) {
        const result = await pollCloudExchange({
          client,
          loginApiBase,
          deviceCode: started.device_code,
          userCode: started.user_code,
        });
        if (result === "pending") {
          await sleep(started.polling_interval_seconds * 1000);
          continue;
        }
        return result;
      }

      const polled = (await client.requestJson(
        "GET",
        `${pollPathPrefix}/${encodeURIComponent(started.device_code)}`,
        { auth: false },
      )) as OssPollResponse;
      if (polled.status === "pending") {
        await sleep(started.polling_interval_seconds * 1000);
        continue;
      }
      if (polled.status === "approved") {
        const creds: StoredCredentials = {
          api_base: polled.api_base,
          mode: "oss",
          api_secret: polled.api_secret,
          authed_at: new Date().toISOString(),
        };
        await writeCredentials(creds);
        log.ok(`Logged in`);
        log.kv("API", polled.api_base);
        log.kv("Token saved to", credentialsPath());
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
          // Hosted: 404 from /auth/cli-exchange means the user code has not
          // yet been approved by a signed-in dashboard user. Keep polling.
          if (isCloud) {
            await sleep(started.polling_interval_seconds * 1000);
            continue;
          }
          log.err("Device code not found.");
          log.info("Run: floom login to start a new session");
          return 1;
        }
        if (error.status === 409 && isCloud) {
          // Hosted: device code is still pending approval.
          await sleep(started.polling_interval_seconds * 1000);
          continue;
        }
        if (error.status === 429 && isCloud) {
          // Hosted: pending approval polls can collide with the cloud rate
          // limiter. Treat it as OAuth device-flow slow_down and honor the
          // server retry window so we do not keep re-tripping the same bucket.
          const retryMs = cloudRateLimitRetryMs(error, started.polling_interval_seconds);
          await sleep(Math.min(retryMs, Math.max(0, deadline - Date.now())));
          continue;
        }
      }
      throw error;
    }
  }
  log.err("Timed out waiting for CLI approval.");
  log.info("Run: floom login to try again");
  return 1;
}

async function pollCloudExchange(args: {
  client: WorkerosApiClient;
  loginApiBase: string;
  deviceCode: string;
  userCode: string;
}): Promise<"pending" | number> {
  const { client, loginApiBase, deviceCode, userCode } = args;
  const exchanged = (await client.requestJson("POST", "/auth/cli-exchange", {
    auth: false,
    body: { device_code: deviceCode, user_code: userCode },
  })) as CloudExchangeResponse;

  let supabaseUrl = exchanged.supabase_url;
  let supabaseAnonKey = exchanged.supabase_anon_key;
  let apiBase = exchanged.api_base || loginApiBase;
  if (!supabaseUrl || !supabaseAnonKey) {
    const bootstrap = await fetchCloudBootstrap(loginApiBase);
    if (!bootstrap) {
      throw new Error(
        "Hosted login succeeded but the server did not return supabase_url / supabase_anon_key. " +
          "Upgrade the cloud API to include /auth/cli-bootstrap or extend /auth/cli-exchange.",
      );
    }
    supabaseUrl = supabaseUrl || bootstrap.supabase_url;
    supabaseAnonKey = supabaseAnonKey || bootstrap.supabase_anon_key;
    apiBase = exchanged.api_base || bootstrap.api_base || loginApiBase;
  }

  const creds: StoredCredentials = {
    api_base: apiBase,
    mode: "cloud",
    refresh_token: exchanged.refresh_token,
    supabase_url: supabaseUrl,
    supabase_anon_key: supabaseAnonKey,
    authed_at: new Date().toISOString(),
  };
  await writeCredentials(creds);
  log.ok(`Logged in`);
  log.kv("API", apiBase);
  log.kv("Token saved to", credentialsPath());
  log.blank();
  log.info("Tip: run `floom workspaces list` to pick a workspace.");
  return 0;
}
