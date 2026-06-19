// Round-09 (Maintainer 2026-06-17): the assistant's name is a WORKSPACE SETTING,
// not a hardcoded "Emily". It is stored in the workspace settings KV under
// `assistant_name` (admin-only PUT, same store as behaviour toggles / model
// defaults), so renaming it in Settings propagates everywhere the name is shown
// (chat header, channels, approvals copy).
//
// This module is the SINGLE SOURCE OF TRUTH for resolving + reading that name.
// All visible "Emily" labels go through it; do not re-hardcode the string.

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

/** The built-in default when the workspace has never set a custom name. */
export const DEFAULT_ASSISTANT_NAME = "Emily";

/** The workspace-settings KV key. */
export const ASSISTANT_NAME_KEY = "assistant_name";

// 32 chars is plenty for a name and keeps headers from overflowing.
const MAX_NAME_LEN = 32;

/** Normalize a raw stored value to a safe display name (or the default). */
export function resolveAssistantName(raw: string | null | undefined): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return DEFAULT_ASSISTANT_NAME;
  return trimmed.slice(0, MAX_NAME_LEN);
}

// Module-level cache so every surface that mounts after the first read shows the
// resolved name immediately (no flash of "Emily" then the custom name), and so a
// rename in Settings updates live surfaces without a reload.
let cachedName: string | null = null;
const listeners = new Set<(name: string) => void>();
let inflight: Promise<void> | null = null;

function broadcast(name: string) {
  cachedName = name;
  for (const fn of listeners) fn(name);
}

/** Push a freshly-saved name into the cache (called by the rename control). */
export function setCachedAssistantName(raw: string | null | undefined) {
  broadcast(resolveAssistantName(raw));
}

async function fetchOnce() {
  if (inflight) return inflight;
  // Wrapped in Promise.resolve().then so a synchronous throw (e.g. api.workspace
  // undefined under a partial test mock) is captured by .catch, never surfacing
  // as an unhandled rejection.
  inflight = Promise.resolve()
    .then(() => api.workspace.getSettings())
    .then((settings) => {
      broadcast(resolveAssistantName(settings?.[ASSISTANT_NAME_KEY]));
    })
    .catch(() => {
      // KV not available (OSS without multi-member, transient error) → default.
      broadcast(DEFAULT_ASSISTANT_NAME);
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/**
 * Read the workspace assistant name. Returns the cached value immediately if
 * known, otherwise the default while it loads, then updates when the KV resolves
 * or when a rename is saved elsewhere in the app.
 */
export function useAssistantName(): string {
  const [name, setName] = useState<string>(cachedName ?? DEFAULT_ASSISTANT_NAME);

  useEffect(() => {
    const fn = (n: string) => setName(n);
    listeners.add(fn);
    if (cachedName !== null) {
      setName(cachedName);
    } else {
      void fetchOnce();
    }
    return () => {
      listeners.delete(fn);
    };
  }, []);

  return name;
}
