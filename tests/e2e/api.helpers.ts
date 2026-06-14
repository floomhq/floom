// Shared helpers for API-level Playwright tests.

export const API = "https://workeros-api.floom.dev/api";
export const WEB = "https://workeros.floom.dev/app";
export const BASE = "https://workeros.floom.dev";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for Workeros Cloud e2e tests`);
  return value;
}

export const ADMIN_TOKEN = requiredEnv("WORKEROS_E2E_ADMIN_TOKEN");
export const MEMBER_TOKEN = requiredEnv("WORKEROS_E2E_MEMBER_TOKEN");
export const JOIN_MEMBER_TOKEN = process.env.WORKEROS_E2E_JOIN_MEMBER_TOKEN?.trim() || MEMBER_TOKEN;
export const WORKSPACE_ID = "ws_8bdb2e8127db4f"; // Nova Search
export const MEMBER_USER_ID = "52b79094-b1aa-40de-b3cb-c4c189052059"; // gohigh3242@gmail.com
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
