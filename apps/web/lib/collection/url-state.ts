/**
 * URL <-> CollectionState (SPEC §8b).
 *
 * `?sel=<id>&tab=<key>&view=list|grid&q=<search>&tag=<family>:<value>` (tag
 * repeatable). Pure functions so back/forward/refresh/deep-link all reconstruct
 * the same state, and so they can be unit-tested without a DOM.
 */
import {
  type CollectionState,
  type TagFamilyKey,
  type ViewMode,
  TAG_FAMILY_ORDER,
} from "./types";

const FAMILY_SET = new Set<string>(TAG_FAMILY_ORDER);

export function emptyState(defaultView: ViewMode = "list"): CollectionState {
  return { sel: null, tab: null, view: defaultView, q: "", tags: {} };
}

/** Parse a read-only URLSearchParams (or any iterable of [k,v]) into state. */
export function parseCollectionState(
  params: URLSearchParams,
  defaultView: ViewMode = "list",
): CollectionState {
  const view = params.get("view");
  const tags: Partial<Record<TagFamilyKey, string[]>> = {};
  for (const raw of params.getAll("tag")) {
    const idx = raw.indexOf(":");
    if (idx <= 0) continue;
    const family = raw.slice(0, idx);
    const value = raw.slice(idx + 1);
    if (!FAMILY_SET.has(family) || !value) continue;
    const key = family as TagFamilyKey;
    const list = tags[key] ?? (tags[key] = []);
    if (!list.includes(value)) list.push(value);
  }
  return {
    sel: params.get("sel") || null,
    tab: params.get("tab") || null,
    view: view === "grid" || view === "list" ? view : defaultView,
    q: params.get("q") ?? "",
    tags,
  };
}

/**
 * Serialize state back to URLSearchParams. Defaults are omitted to keep URLs
 * clean (no `view=list`, no empty `q`, no `tab` without a selection).
 */
export function serializeCollectionState(
  state: CollectionState,
  defaultView: ViewMode = "list",
): URLSearchParams {
  const p = new URLSearchParams();
  if (state.sel) p.set("sel", state.sel);
  if (state.sel && state.tab) p.set("tab", state.tab);
  if (state.view && state.view !== defaultView) p.set("view", state.view);
  if (state.q) p.set("q", state.q);
  // Stable order: family order, then value order, so URLs are deterministic.
  for (const family of TAG_FAMILY_ORDER) {
    for (const value of state.tags[family] ?? []) {
      p.append("tag", `${family}:${value}`);
    }
  }
  return p;
}

/** Toggle one tag value within its family (multi-select; SPEC §1). */
export function toggleTag(
  state: CollectionState,
  family: TagFamilyKey,
  value: string,
): CollectionState {
  const current = state.tags[family] ?? [];
  const next = current.includes(value)
    ? current.filter((v) => v !== value)
    : [...current, value];
  const tags = { ...state.tags };
  if (next.length) tags[family] = next;
  else delete tags[family];
  return { ...state, tags };
}

/** Deselect-all → show everything (the "all" chip; SPEC §1). */
export function clearTags(state: CollectionState): CollectionState {
  return { ...state, tags: {} };
}

/** True when no tag in any family is active (the resting "all" state). */
export function noTagsActive(state: CollectionState): boolean {
  return Object.values(state.tags).every((v) => !v || v.length === 0);
}
