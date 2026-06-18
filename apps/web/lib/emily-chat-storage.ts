"use client";

import { safeStorageGet, safeStorageRemove, safeStorageSet } from "@/lib/safe-storage";

/**
 * Emily chat — persistent conversation id.
 *
 * The active conversation id is persisted to localStorage (namespaced) so the
 * conversation survives EmilyDock close→reopen, switching between the dock and
 * the full /chat (or /assistant) page, and a full browser reload. On mount the
 * stream hook reads this id and rehydrates from GET /conversations/{id}.
 */

export const CONVERSATION_STORAGE_KEY = "workeros.emily.conversationId";

export function readStoredConversationId(): string | null {
  const value = safeStorageGet("local", CONVERSATION_STORAGE_KEY);
  return value && value.trim() ? value : null;
}

export function writeStoredConversationId(id: string): void {
  safeStorageSet("local", CONVERSATION_STORAGE_KEY, id);
}

export function clearStoredConversationId(): void {
  safeStorageRemove("local", CONVERSATION_STORAGE_KEY);
}
