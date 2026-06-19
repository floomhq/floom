import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";

function makeMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  };
}

function ensureUsableLocalStorage() {
  try {
    const storage = window.localStorage;
    if (
      typeof storage?.getItem === "function" &&
      typeof storage.setItem === "function" &&
      typeof storage.removeItem === "function" &&
      typeof storage.clear === "function"
    ) {
      return;
    }
  } catch {
    // Replace unavailable storage below.
  }

  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: makeMemoryStorage(),
  });
}

// Unmount React trees between tests (jsdom project runs with globals).
beforeEach(() => ensureUsableLocalStorage());
afterEach(() => {
  cleanup();
  ensureUsableLocalStorage();
});
