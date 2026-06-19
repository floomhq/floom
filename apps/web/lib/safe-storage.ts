export type StorageArea = "local" | "session";

function getStorage(area: StorageArea): Storage | null {
  try {
    const browserWindow = typeof window === "undefined" ? undefined : window;
    const globals = globalThis as typeof globalThis & {
      localStorage?: Storage;
      sessionStorage?: Storage;
    };
    return area === "local"
      ? browserWindow?.localStorage ?? globals.localStorage ?? null
      : browserWindow?.sessionStorage ?? globals.sessionStorage ?? null;
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

export function safeStorageSet(area: StorageArea, key: string, value: string): void {
  try {
    getStorage(area)?.setItem(key, value);
  } catch {
    /* storage unavailable or quota exceeded */
  }
}

export function safeStorageRemove(area: StorageArea, key: string): void {
  try {
    getStorage(area)?.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}

export function safeStorageClear(area: StorageArea): void {
  try {
    getStorage(area)?.clear();
  } catch {
    /* storage unavailable */
  }
}

export function getSafeStorage(area: StorageArea): Storage | null {
  return getStorage(area);
}
