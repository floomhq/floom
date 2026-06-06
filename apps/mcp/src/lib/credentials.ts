import { chmodSync, existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// AuthMode determines how the CLI hits the API:
// - "oss" -> single-tenant OSS engine, x-floom-secret header, no workspaces
// - "cloud" -> workeros-cloud, Supabase refresh token + JWT bearer OR PAT, workspace header
export type AuthMode = "oss" | "cloud";

export type StoredCredentials = {
  api_base: string;
  mode: AuthMode;
  // OSS mode: per-CLI shared secret minted by /cli-auth/devices.
  api_secret?: string;
  // Cloud mode: Personal Access Token sent as x-floom-token.
  api_token?: string;
  // Cloud mode: Supabase refresh token (returned by /auth/cli-exchange).
  refresh_token?: string;
  // Cloud mode: Supabase project URL (so the CLI can refresh JWTs).
  supabase_url?: string;
  // Cloud mode: Supabase anon key (needed for the /auth/v1/token refresh call).
  supabase_anon_key?: string;
  // Cloud mode: currently-active workspace id. Sent as X-Workeros-Workspace.
  workspace_id?: string;
  // Cloud mode: human-readable workspace name (for `floom workspaces show`).
  workspace_name?: string;
  authed_at: string;
};

const DEFAULT_OSS_API_BASE = "https://workers-api.floom.dev";
const DEFAULT_CLOUD_API_BASE = "https://workeros-api.floom.dev";

function envApiBase(defaultBase: string): string {
  return (process.env.WORKEROS_API_BASE || process.env.FLOOM_API_BASE || defaultBase).replace(/\/+$/, "");
}

function resolveHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || "";
}

export function credentialsPath(): string {
  const home = resolveHomeDir();
  if (!home) {
    throw new Error("HOME is required to read CLI credentials");
  }
  return join(home, ".config", "workeros", "credentials.json");
}

export async function readCredentials(): Promise<StoredCredentials | null> {
  const envCloudToken = process.env.WORKEROS_API_TOKEN?.trim();
  if (envCloudToken) {
    return {
      api_base: envApiBase(DEFAULT_CLOUD_API_BASE),
      mode: "cloud",
      api_token: envCloudToken,
      workspace_id: process.env.WORKEROS_WORKSPACE_ID?.trim() || undefined,
      workspace_name: process.env.WORKEROS_WORKSPACE_NAME?.trim() || undefined,
      authed_at: new Date().toISOString(),
    };
  }

  const envOssSecret = (process.env.WORKEROS_API_SECRET || process.env.FLOOM_API_SECRET || "").trim();
  if (envOssSecret) {
    return {
      api_base: envApiBase(DEFAULT_OSS_API_BASE),
      mode: "oss",
      api_secret: envOssSecret,
      authed_at: new Date().toISOString(),
    };
  }

  const path = credentialsPath();
  if (!existsSync(path)) {
    return null;
  }
  const raw = (await readFile(path, "utf8")).trim();
  if (!raw) {
    return null;
  }
  const parsed = JSON.parse(raw) as Partial<StoredCredentials>;
  // Back-compat: existing creds files only have api_base + api_secret +
  // authed_at. Treat them as OSS mode.
  const mode: AuthMode = parsed.mode === "cloud" ? "cloud" : "oss";
  if (mode === "oss" && !parsed.api_secret) {
    return null;
  }
  if (mode === "cloud" && !parsed.api_token && (!parsed.refresh_token || !parsed.supabase_url)) {
    return null;
  }
  return {
    api_base: (parsed.api_base || DEFAULT_OSS_API_BASE).replace(/\/+$/, ""),
    mode,
    api_secret: parsed.api_secret,
    api_token: parsed.api_token,
    refresh_token: parsed.refresh_token,
    supabase_url: parsed.supabase_url ? parsed.supabase_url.replace(/\/+$/, "") : undefined,
    supabase_anon_key: parsed.supabase_anon_key,
    workspace_id: parsed.workspace_id,
    workspace_name: parsed.workspace_name,
    authed_at: parsed.authed_at || new Date().toISOString(),
  };
}

export async function writeCredentials(credentials: StoredCredentials): Promise<void> {
  const path = credentialsPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const payload = JSON.stringify(credentials, null, 2);
  await writeFile(path, `${payload}\n`, "utf8");
  chmodSync(path, 0o600);
}

export async function updateCredentials(
  partial: Partial<StoredCredentials>,
): Promise<StoredCredentials> {
  const current = await readCredentials();
  if (!current) {
    throw new Error("Not logged in. Run floom login first.");
  }
  const next: StoredCredentials = { ...current, ...partial };
  await writeCredentials(next);
  return next;
}

export async function clearCredentials(): Promise<boolean> {
  const path = credentialsPath();
  if (!existsSync(path)) {
    return false;
  }
  await rm(path, { force: true });
  return true;
}

export function maskSecret(secret: string): string {
  if (!secret) return "";
  if (secret.length <= 4) return "*".repeat(secret.length);
  return `${"*".repeat(secret.length - 4)}${secret.slice(-4)}`;
}
