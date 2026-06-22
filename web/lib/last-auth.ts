// Tracks which auth method the user last signed in with, so /login can surface
// a "Last used" hint (the Supabase / Lovable pattern). Stored client-side only —
// a UX nudge, never an auth signal.
export type LastAuthMethod = "google" | "github" | "email";

export const LAST_AUTH_KEY = "floom:last-auth-method";

const VALID: readonly LastAuthMethod[] = ["google", "github", "email"];

export function getLastAuthMethod(): LastAuthMethod | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(LAST_AUTH_KEY);
    return VALID.includes(value as LastAuthMethod) ? (value as LastAuthMethod) : null;
  } catch {
    return null;
  }
}

export function setLastAuthMethod(method: LastAuthMethod): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAST_AUTH_KEY, method);
  } catch {
    // private mode / storage disabled — the hint is non-essential.
  }
}
