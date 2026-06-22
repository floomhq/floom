import open from "open";
import { mkdir, open as openFile, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  FloomApiClient,
  FloomApiError,
  resolveLoginApiBase,
} from "../lib/api.js";
import { promptYesNo } from "../lib/prompt.js";
import { getCommandName } from "../lib/command-name.js";
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
  refresh_token?: string;
  api_token?: string;
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

type WorkspaceRow = {
  id: string;
  name?: string;
};

type WorkspaceListResponse = {
  workspaces?: WorkspaceRow[];
  active_id?: string | null;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loginLockPath(): string {
  return join(dirname(credentialsPath()), "login.lock");
}

function processAppearsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function acquireLoginLock(): Promise<() => Promise<void>> {
  const path = loginLockPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const payload = {
    pid: process.pid,
    started_at: new Date().toISOString(),
  };
  try {
    const handle = await openFile(path, "wx", 0o600);
    await handle.writeFile(JSON.stringify(payload, null, 2) + "\n", "utf8");
    await handle.close();
  } catch (error) {
    const existing: { pid?: unknown; started_at?: unknown } = await readFile(path, "utf8").then(
      (raw) => JSON.parse(raw) as { pid?: unknown; started_at?: unknown },
      () => ({}),
    );
    const pid = typeof existing.pid === "number" ? existing.pid : 0;
    if (processAppearsAlive(pid)) {
      throw new Error(
        `Another ${getCommandName()} login is already running (pid ${pid}). ` +
          "Finish it or stop that process before starting a new device code.",
      );
    }
    await rm(path, { force: true });
    const handle = await openFile(path, "wx", 0o600);
    await handle.writeFile(JSON.stringify(payload, null, 2) + "\n", "utf8");
    await handle.close();
  }
  return async () => {
    const existing: { pid?: unknown } = await readFile(path, "utf8").then(
      (raw) => JSON.parse(raw) as { pid?: unknown },
      () => ({}),
    );
    if (existing.pid === process.pid) {
      await rm(path, { force: true });
    }
  };
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
  error: FloomApiError,
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

// Heuristic: the cloud verification_url points at floom.example.com
// (or /app/cli-auth). The OSS engine points at localhost:3000/cli-auth.
// Lets the CLI auto-detect cloud-vs-oss even when --cloud is omitted, so a
// user running `floom login` against WORKEROS_API_BASE=<cloud> still gets
// the right flow.
function detectCloudFromVerificationUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.hostname === "floom.example.com") return true;
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
  const releaseLoginLock = await acquireLoginLock();
  try {
  log.heading("Login");
  log.step("Requesting device authorization...");

  const loginApiBase = resolveLoginApiBase(options);
  const client = new FloomApiClient(loginApiBase);
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
        log.info(`Try: ${getCommandName()} workers list`);
        return 0;
      }
      await sleep(started.polling_interval_seconds * 1000);
    } catch (error) {
      if (error instanceof FloomApiError) {
        if (error.status === 403) {
          log.err("CLI authorization was denied.");
          log.info(`Run: ${getCommandName()} login to try again`);
          return 1;
        }
        if (error.status === 410) {
          log.err("Device code expired before approval.");
          log.info(`Run: ${getCommandName()} login to start a new session`);
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
          log.info(`Run: ${getCommandName()} login to start a new session`);
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
  log.info(`Run: ${getCommandName()} login to try again`);
  return 1;
  } finally {
    await releaseLoginLock();
  }
}

async function pollCloudExchange(args: {
  client: FloomApiClient;
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
  if (exchanged.api_token) {
    const creds: StoredCredentials = {
      api_base: apiBase,
      mode: "cloud",
      api_token: exchanged.api_token,
      authed_at: new Date().toISOString(),
    };
    return saveCloudCredentials(creds, apiBase);
  }
  if (!exchanged.refresh_token) {
    throw new Error("Hosted login succeeded but the server did not return a usable CLI credential.");
  }
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
  return saveCloudCredentials(creds, apiBase);
}

async function saveCloudCredentials(creds: StoredCredentials, apiBase: string): Promise<number> {
  const workspace = await resolveInitialCloudWorkspace(creds);
  const savedCreds: StoredCredentials = {
    ...creds,
    ...(workspace
      ? {
          workspace_id: workspace.id,
          workspace_name: workspace.name || workspace.id,
        }
      : {}),
  };
  await writeCredentials(savedCreds);
  log.ok(`Logged in`);
  log.kv("API", apiBase);
  if (workspace) {
    log.kv("Workspace", `${workspace.name || workspace.id} (${workspace.id})`);
  }
  log.kv("Token saved to", credentialsPath());
  log.blank();
  if (workspace) {
    log.info(`Tip: run \`${getCommandName()} workers list\` to inspect this workspace.`);
  } else {
    log.info(`Tip: run \`${getCommandName()} workspaces list\` to pick a workspace.`);
  }
  return 0;
}

export async function resolveInitialCloudWorkspace(
  credentials: StoredCredentials,
): Promise<WorkspaceRow | null> {
  try {
    const client = new FloomApiClient(credentials.api_base, credentials);
    const data = (await client.requestJson("GET", "/workspaces")) as WorkspaceListResponse;
    const workspaces = Array.isArray(data.workspaces) ? data.workspaces : [];
    if (data.active_id) {
      const active = workspaces.find((row) => row.id === data.active_id);
      if (active) return active;
      return { id: data.active_id, name: data.active_id };
    }
    if (workspaces.length === 1) {
      return workspaces[0];
    }
    return null;
  } catch {
    return null;
  }
}
