// action-buckets.ts (#1671)
//
// A connection (e.g. Gmail) can expose 60+ raw API actions. Listed flat, they
// read like an API console ("Fetch message by message ID", "Get People",
// "Modify email labels"…) — overwhelming for a "hire AI workers" product.
//
// This module groups actions into a handful of plain-language buckets, derived
// PURELY from the action's name/id (no backend/catalog change). The taxonomy is
// a STARTING POINT — it's a single small pure function so Federico can tweak the
// keyword sets without touching the panel. Grouping is display-only: the
// underlying action data is never mutated.

export type ActionBucketKey =
  | "read"
  | "send"
  | "organize"
  | "manage"
  | "other";

export interface ActionBucketDef {
  key: ActionBucketKey;
  /** Plain-language label shown on the collapsible section header. */
  label: string;
  /** One-line description of what this bucket does. */
  blurb: string;
  /** Expand this bucket by default (the common, high-signal ones). */
  defaultOpen: boolean;
}

// Ordered most-common → long-tail. The order here is also the render order.
export const ACTION_BUCKETS: ActionBucketDef[] = [
  {
    key: "read",
    label: "Read & fetch",
    blurb: "Look things up and pull information in.",
    defaultOpen: true,
  },
  {
    key: "send",
    label: "Send & create",
    blurb: "Send messages and create or update items.",
    defaultOpen: true,
  },
  {
    key: "organize",
    label: "Organize",
    blurb: "Label, move and tidy things up.",
    defaultOpen: false,
  },
  {
    key: "manage",
    label: "Manage",
    blurb: "Delete or remove items.",
    defaultOpen: false,
  },
  {
    key: "other",
    label: "Other",
    blurb: "Everything else this app can do.",
    defaultOpen: false,
  },
];

// Verb → bucket. The classifier matches the FIRST word-ish token of the action
// name against these sets (case-insensitive). A leading "GMAIL_" / app prefix or
// snake/camel casing is normalized away before matching, so both human labels
// ("Fetch message by message ID") and raw ids ("GMAIL_FETCH_MESSAGE") classify
// the same. Keep these as plain verbs — that's the knob to tune.
const BUCKET_VERBS: Record<Exclude<ActionBucketKey, "other">, string[]> = {
  // Read & fetch — pulling data in.
  read: ["get", "fetch", "list", "search", "read", "find", "query", "lookup", "retrieve", "view", "download", "count"],
  // Send & create — pushing data out / making new things.
  send: ["send", "create", "draft", "reply", "add", "post", "write", "upload", "set", "update", "modify", "edit", "compose", "share", "submit", "patch", "insert", "publish"],
  // Organize — labels, folders, status flags.
  organize: ["label", "move", "archive", "mark", "tag", "categorize", "sort", "pin", "star", "flag", "filter", "organize"],
  // Manage — destructive / lifecycle.
  manage: ["delete", "remove", "trash", "purge", "destroy", "cancel", "revoke", "disable", "deactivate", "unsubscribe", "clear"],
};

/**
 * Normalize an action name/id to a lowercased list of leading verb candidates.
 * Strips a leading app prefix ("GMAIL_FETCH_…" → "fetch …") and splits on
 * snake_case, camelCase, and whitespace so the first meaningful token surfaces.
 */
function leadingTokens(name: string): string[] {
  const cleaned = name
    // camelCase → spaced
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    // snake / kebab / punctuation → spaces
    .replace(/[_\-./]+/g, " ")
    .trim()
    .toLowerCase();
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  // If the first word looks like an app prefix (no verb match anywhere in the
  // verb sets) AND there is a following word, also offer the second word. We
  // keep it simple: return the first two words as candidates.
  return words.slice(0, 2);
}

const ALL_VERBS = new Set<string>(
  Object.values(BUCKET_VERBS).flat()
);

/**
 * Pure classifier: maps a single action name/id to a bucket key.
 *
 * Heuristic, in order:
 *   1. First token is a known verb → its bucket.
 *   2. First token is an app prefix (not a verb) and the SECOND token is a known
 *      verb → that bucket (handles "GMAIL_FETCH_MESSAGE").
 *   3. Otherwise → "other".
 */
export function bucketForAction(name: string): ActionBucketKey {
  const [first, second] = leadingTokens(name);
  if (!first) return "other";

  const matchVerb = (word: string | undefined): ActionBucketKey | null => {
    if (!word) return null;
    for (const key of ["read", "send", "organize", "manage"] as const) {
      if (BUCKET_VERBS[key].includes(word)) return key;
    }
    return null;
  };

  const direct = matchVerb(first);
  if (direct) return direct;

  // First token wasn't a verb at all (likely an app prefix) → try the second.
  if (!ALL_VERBS.has(first)) {
    const fromSecond = matchVerb(second);
    if (fromSecond) return fromSecond;
  }

  return "other";
}

export interface BucketedActions<T> {
  def: ActionBucketDef;
  items: T[];
}

/**
 * Group a list of actions into the ordered bucket list, dropping empty buckets.
 * Pure: returns a new structure, never mutates the input items.
 */
export function groupActions<T>(
  items: T[],
  nameOf: (item: T) => string
): BucketedActions<T>[] {
  const byKey = new Map<ActionBucketKey, T[]>();
  for (const item of items) {
    const key = bucketForAction(nameOf(item));
    const arr = byKey.get(key);
    if (arr) arr.push(item);
    else byKey.set(key, [item]);
  }
  return ACTION_BUCKETS.map((def) => ({
    def,
    items: byKey.get(def.key) ?? [],
  })).filter((g) => g.items.length > 0);
}
