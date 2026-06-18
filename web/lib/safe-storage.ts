"use client";

export type StorageArea = "local" | "session";

function getStorage(area: StorageArea): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    const globals = globalThis as typeof globalThis & {
      localStorage?: Storage;
      sessionStorage?: Storage;
    };
    const storage =
      area === "local"
        ? window.localStorage ?? globals.localStorage ?? null
        : window.sessionStorage ?? globals.sessionStorage ?? null;
    if (!storage) return null;
    const probe = "__workeros_storage_probe__";
    storage.setItem(probe, "1");
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

export function safeStorageGet(area: StorageArea, key: string): string | null {
  try {
    return getStorage(area)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function safeStorageSet(area: StorageArea, key: string, value: string): boolean {
  try {
    const storage = getStorage(area);
    if (!storage) return false;
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function safeStorageRemove(area: StorageArea, key: string): void {
  try {
    getStorage(area)?.removeItem(key);
  } catch {
    // Storage is best-effort UI state only.
  }
}

export function getSafeStorage(area: StorageArea): Storage | null {
  return getStorage(area);
}
