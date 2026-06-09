/**
 * Filtering semantics (SPEC §1).
 *
 * - Tags are multi-select. A family with NO active values does not filter.
 * - Within a family: OR (any active value matches).
 * - Across families: AND (every active family must pass).
 * - Search ANDs with tags (search within the active tag filter).
 *
 * Pure + dependency-free so it can be unit-tested and reused server-side.
 */
import type { CollectionState, TagFamilyKey } from "./types";

export interface FilterAccessors<T> {
  searchOf: (item: T) => string;
  tagsOf?: (item: T) => Partial<Record<TagFamilyKey, string[]>>;
}

/** Does `itemTags` satisfy the active tag selection? */
export function matchesTags(
  active: Partial<Record<TagFamilyKey, string[]>>,
  itemTags: Partial<Record<TagFamilyKey, string[]>>,
): boolean {
  for (const family of Object.keys(active) as TagFamilyKey[]) {
    const wanted = active[family];
    if (!wanted || wanted.length === 0) continue; // family not filtering
    const have = itemTags[family] ?? [];
    // OR within family: item must carry at least one wanted value.
    if (!wanted.some((w) => have.includes(w))) return false;
  }
  return true;
}

/** Case-insensitive substring match against the item's search text. */
export function matchesSearch(query: string, text: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return text.toLowerCase().includes(q);
}

export function filterItems<T>(
  items: T[],
  state: CollectionState,
  acc: FilterAccessors<T>,
): T[] {
  const hasQuery = state.q.trim().length > 0;
  const hasTags = Object.values(state.tags).some((v) => v && v.length > 0);
  if (!hasQuery && !hasTags) return items;
  return items.filter((item) => {
    if (hasTags && acc.tagsOf && !matchesTags(state.tags, acc.tagsOf(item))) {
      return false;
    }
    if (hasQuery && !matchesSearch(state.q, acc.searchOf(item))) return false;
    return true;
  });
}
