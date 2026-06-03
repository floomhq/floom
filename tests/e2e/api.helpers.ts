// Shared helpers for API-level Playwright tests.

export const API = "https://workeros-api.floom.dev/api";
export const WEB = "https://workeros.floom.dev/app";

export const ADMIN_TOKEN = "floom_oJlwTHF6nRHV3Sd0u2rYz9vslSVRCA2HFZB65lIbJqE";
export const MEMBER_TOKEN = "floom_J3G55Cd0GMnDQ66CQ9MlpM7W4jrEn84pbSxEi32LCaI";
export const WORKSPACE_ID = "ws_8bdb2e8127db4f"; // Nova Search

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
