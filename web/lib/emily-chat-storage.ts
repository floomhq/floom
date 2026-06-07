"use client";

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
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(CONVERSATION_STORAGE_KEY);
    return value && value.trim() ? value : null;
  } catch {
    return null;
  }
}

export function writeStoredConversationId(id: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CONVERSATION_STORAGE_KEY, id);
  } catch {
    /* storage unavailable (private mode / quota) — non-fatal */
  }
}

export function clearStoredConversationId(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(CONVERSATION_STORAGE_KEY);
  } catch {
    /* non-fatal */
  }
}
