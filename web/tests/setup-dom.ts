import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";

function createMemoryStorage(): Storage {
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

function ensureStorage(name: "localStorage" | "sessionStorage") {
  const storage = window[name];
  if (
    storage &&
    typeof storage.getItem === "function" &&
    typeof storage.setItem === "function" &&
    typeof storage.removeItem === "function" &&
    typeof storage.clear === "function"
  ) {
    return;
  }
  Object.defineProperty(window, name, {
    configurable: true,
    value: createMemoryStorage(),
  });
}

beforeEach(() => {
  ensureStorage("localStorage");
  ensureStorage("sessionStorage");
});

// Unmount React trees between tests (jsdom project runs with globals).
afterEach(() => {
  cleanup();
  ensureStorage("localStorage");
  ensureStorage("sessionStorage");
});
