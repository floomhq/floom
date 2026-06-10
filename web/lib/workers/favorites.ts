/**
 * Worker favorites (the "Starred" smart tag). Stored client-side in
 * localStorage under the SAME key the legacy WorkersClient used, so existing
 * stars carry over after the migration.
 */
const LS_KEY_FAVORITES = "workeros:favorites";

export function getFavorites(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(LS_KEY_FAVORITES);
    return new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

export function saveFavorites(favs: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(LS_KEY_FAVORITES, JSON.stringify(Array.from(favs)));
  } catch {
    /* ignore quota / privacy-mode errors */
  }
}
