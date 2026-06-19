// Single source of truth for the OSS single-user API secret (x-floom-secret).
//
// The same token is used by Settings → Connect & automate (CliCommandPanel) AND
// the sidebar MCP-install popup AND the shared MCP-install panel. It is minted
// via the CLI device-auth flow (POST /cli-auth/devices → /approve → /poll) and
// cached in sessionStorage (#1185: not localStorage, so XSS/extensions can't
// read it across sessions). Legacy localStorage keys are migrated + purged.
//
// Before this lib, readStoredSecret() + generateToken() were copy-pasted into
// both CliCommandPanel and McpInstallModal. Two copies of the same security-
// sensitive flow drift. This is the one implementation.
import { safeStorageGet, safeStorageRemove, safeStorageSet } from "@/lib/safe-storage";

const SECRET_SESSION_KEY = "workeros_api_secret";
const SECRET_LEGACY_LS_KEYS = ["floom_secret", "FLOOM_SECRET", "workeros_api_secret"];
const PROXY_BASE = "/api/proxy";

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

/**
 * Mint a fresh OSS API token via the CLI device-auth flow and cache it.
 *
 * The flow is three proxied calls: start the device (`/cli-auth/devices`),
 * approve it as the current user (`/cli-auth/approve`), then poll for the issued
 * secret (`/cli-auth/poll/{device_code}`). On success the token is stored AND
 * returned so callers can bake it straight into a copy snippet.
 *
 * Throws an Error with the backend `detail` (or a stable fallback message) when
 * any leg fails, so the caller can surface it inline.
 */
export async function generateOssToken(clientName: string): Promise<string> {
  const startedResponse = await fetch(`${PROXY_BASE}/cli-auth/devices`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: clientName, scopes: [] }),
  });
  const started = (await startedResponse.json().catch(() => ({}))) as {
    device_code?: string;
    user_code?: string;
    detail?: string;
  };
  if (!startedResponse.ok || !started.device_code || !started.user_code) {
    throw new Error(started.detail || "Could not start token generation");
  }

  const approvedResponse = await fetch(`${PROXY_BASE}/cli-auth/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_code: started.user_code }),
  });
  const approved = (await approvedResponse.json().catch(() => ({}))) as { detail?: string };
  if (!approvedResponse.ok) {
    throw new Error(approved.detail || "Could not approve token generation");
  }

  const polledResponse = await fetch(
    `${PROXY_BASE}/cli-auth/poll/${encodeURIComponent(started.device_code)}`,
  );
  const polled = (await polledResponse.json().catch(() => ({}))) as {
    api_secret?: string;
    detail?: string;
  };
  if (!polledResponse.ok || !polled.api_secret) {
    throw new Error(polled.detail || "Generated token was not returned");
  }

  storeSecret(polled.api_secret);
  return polled.api_secret;
}
