"use client";

import { safeStorageRemove } from "@/lib/safe-storage";
import { PERSIST_STORAGE_KEY } from "@/lib/query/persist";
import { CONVERSATION_STORAGE_KEY } from "@/lib/emily-chat-storage";

export const LOGOUT_LOCAL_STORAGE_KEYS = [
  PERSIST_STORAGE_KEY,
  "workeros.activeWorkspaceId",
  CONVERSATION_STORAGE_KEY,
  "workeros:favorites",
  "floom.workerDetail.pinnedTabs",
] as const;

export const LOGOUT_LOCAL_STORAGE_PREFIXES = [
  "workeros.workerInputTemplates.",
] as const;

function clearActiveWorkspaceCookie(): void {
  if (typeof document === "undefined") return;
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `workeros.activeWorkspaceId=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
}

export function clearClientLogoutState(): void {
  for (const key of LOGOUT_LOCAL_STORAGE_KEYS) {
    safeStorageRemove("local", key);
  }
  try {
    const storage = window.localStorage;
    for (let i = storage.length - 1; i >= 0; i--) {
      const key = storage.key(i);
      if (!key) continue;
      if (LOGOUT_LOCAL_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix))) {
        storage.removeItem(key);
      }
    }
  } catch {
    // localStorage can be unavailable in private/locked-down browser contexts.
  }
  clearActiveWorkspaceCookie();
}
