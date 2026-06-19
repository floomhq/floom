/**
 * Worker favorites (the "Starred" smart tag). Stored client-side in
 * localStorage under the SAME key the legacy WorkersClient used, so existing
 * stars carry over after the migration.
 */
import { safeStorageGet, safeStorageSet } from "@/lib/safe-storage";

const LS_KEY_FAVORITES = "workeros:favorites";

export function getFavorites(): Set<string> {
  try {
    const raw = safeStorageGet("local", LS_KEY_FAVORITES);
    return new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

export function saveFavorites(favs: Set<string>): void {
  safeStorageSet("local", LS_KEY_FAVORITES, JSON.stringify(Array.from(favs)));
}
