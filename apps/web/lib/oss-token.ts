// Single source of truth for the dashboard API credential used in MCP/CLI snippets.
//
// The same token is used by Settings → Connect & automate (CliCommandPanel) AND
// the sidebar MCP-install popup AND the shared MCP-install panel. It is cached in
// sessionStorage (#1185: not localStorage, so XSS/extensions can't read it across
// sessions). Legacy localStorage keys are migrated + purged.
//
// OSS: minted via the CLI device-auth flow (POST /cli-auth/devices → /approve →
// /poll) and sent as x-floom-secret.
//
// Cloud: the signed-in user already has a session — mint a PAT via POST
// /auth/tokens (proxied) and send it as Authorization: Bearer in MCP configs.
import { safeStorageGet, safeStorageRemove, safeStorageSet } from "@/lib/safe-storage";

const SECRET_SESSION_KEY = "workeros_api_secret";
const SECRET_LEGACY_LS_KEYS = ["floom_secret", "FLOOM_SECRET", "workeros_api_secret"];
const API_PROXY_BASE = process.env.NEXT_PUBLIC_API_PROXY_BASE || "/api/proxy";
const WEB_BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH || "").replace(/\/$/, "");

function isCloudDeploy(): boolean {
  return process.env.NEXT_PUBLIC_WORKEROS_DEPLOY === "cloud";
}

type JsonBody = { detail?: string; token?: string; device_code?: string; user_code?: string; api_secret?: string };

async function readJson(response: Response): Promise<JsonBody> {
  return (await response.json().catch(() => ({}))) as JsonBody;
}

function errorDetail(response: Response, body: JsonBody, fallback: string): string {
  if (response.status === 401) {
    return body.detail || "Sign in to create an API key";
  }
  if (response.status === 403) {
    return body.detail || "Not authorized — refresh the page and try again";
  }
  if (response.status === 429) {
    return body.detail || "Too many requests — wait a moment and try again";
  }
  if (response.status === 404) {
    return body.detail || "API route not found — check your deployment base path";
  }
  return body.detail || fallback;
}

/** Read the cached OSS secret, migrating any legacy localStorage value into
 *  sessionStorage (and purging the localStorage copy) on the way. Empty when
 *  none is stored yet. */
export function readStoredSecret(): string {
  for (const key of SECRET_LEGACY_LS_KEYS) {
    const ls = safeStorageGet("local", key);
    if (ls && ls.trim()) {
      safeStorageSet("session", SECRET_SESSION_KEY, ls.trim());
      safeStorageRemove("local", key);
      return ls.trim();
    }
  }
  return safeStorageGet("session", SECRET_SESSION_KEY)?.trim() ?? "";
}

/** Cache the OSS secret in sessionStorage (cleared when the tab closes). */
export function storeSecret(value: string): void {
  safeStorageSet("session", SECRET_SESSION_KEY, value);
}

/** Forget the cached OSS secret (session + any lingering legacy localStorage). */
export function clearStoredSecret(): void {
  safeStorageRemove("session", SECRET_SESSION_KEY);
  for (const key of SECRET_LEGACY_LS_KEYS) safeStorageRemove("local", key);
}

async function generateCloudPat(clientName: string): Promise<string> {
  const label = `MCP: ${clientName}`.trim().slice(0, 100) || "MCP install";
  const response = await fetch(`${API_PROXY_BASE}/auth/tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: label }),
  });
  const body = await readJson(response);
  const token = body.token?.trim() ?? "";
  if (!response.ok || !token) {
    throw new Error(errorDetail(response, body, "Could not create API key"));
  }
  storeSecret(token);
  return token;
}

async function generateOssDeviceToken(clientName: string): Promise<string> {
  const startedResponse = await fetch(`${API_PROXY_BASE}/cli-auth/devices`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: clientName, scopes: [] }),
  });
  const started = await readJson(startedResponse);
  if (!startedResponse.ok || !started.device_code || !started.user_code) {
    throw new Error(errorDetail(startedResponse, started, "Could not start token generation"));
  }

  const approveBase = isCloudDeploy()
    ? `${WEB_BASE_PATH}/api/cli-auth`
    : `${API_PROXY_BASE}/cli-auth`;
  const approvedResponse = await fetch(`${approveBase}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_code: started.user_code }),
  });
  const approved = await readJson(approvedResponse);
  if (!approvedResponse.ok) {
    throw new Error(errorDetail(approvedResponse, approved, "Could not approve token generation"));
  }

  const polledResponse = await fetch(
    `${API_PROXY_BASE}/cli-auth/poll/${encodeURIComponent(started.device_code)}`,
  );
  const polled = await readJson(polledResponse);
  if (!polledResponse.ok || !polled.api_secret) {
    throw new Error(errorDetail(polledResponse, polled, "Generated token was not returned"));
  }

  storeSecret(polled.api_secret);
  return polled.api_secret;
}

/**
 * Mint a fresh API credential for MCP/CLI snippets and cache it in sessionStorage.
 *
 * OSS uses the three-step device-auth flow (devices → approve → poll).
 * Cloud mints a PAT for the signed-in dashboard user (POST /auth/tokens).
 *
 * Throws an Error with the backend `detail` (or a stable fallback) when any
 * step fails, so callers can surface it inline.
 */
export async function generateOssToken(clientName: string): Promise<string> {
  if (isCloudDeploy()) {
    return generateCloudPat(clientName);
  }
  return generateOssDeviceToken(clientName);
}
