// Shared helpers for API-level Playwright tests.

export const API = "https://workeros-api.floom.dev/api";
export const WEB = "https://workeros.floom.dev/app";

export const ADMIN_TOKEN = "floom_oJlwTHF6nRHV3Sd0u2rYz9vslSVRCA2HFZB65lIbJqE";
export const MEMBER_TOKEN = "floom_J3G55Cd0GMnDQ66CQ9MlpM7W4jrEn84pbSxEi32LCaI";
export const WORKSPACE_ID = "ws_8bdb2e8127db4f"; // Nova Search
export const MEMBER_USER_ID = "47c14184-77d2-4b70-8790-1b073384cc8e"; // vivekbs.10@gmail.com
export const SHARED_WORKER_ID = "clone-test-worker"; // known shared worker for run tests

export function adminHeaders(extra: Record<string, string> = {}) {
  return {
    "x-floom-token": ADMIN_TOKEN,
    "x-workeros-workspace": WORKSPACE_ID,
    "Content-Type": "application/json",
    ...extra,
  };
}

export function memberHeaders(extra: Record<string, string> = {}) {
  return {
    "x-floom-token": MEMBER_TOKEN,
    "x-workeros-workspace": WORKSPACE_ID,
    "Content-Type": "application/json",
    ...extra,
  };
}
