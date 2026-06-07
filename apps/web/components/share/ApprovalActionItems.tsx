"use client";

// v6 approval surface helpers. Render the ACTUAL action items an approval will
// execute (never just a count), in a GENERIC way: whatever structured items the
// worker proposed (a list of records, a list of strings, or a single object)
// render as plain rows — no use-case-specific chrome (no HubSpot/Slack-branded
// item layout). A bold plain-language action line summarises the request for a
// non-technical approver.

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

// Pull the most plausible array of action items out of the decision input,
// trying common keys before falling back to the first array value found.
function extractItems(decisionInput: Json): unknown[] | null {
  for (const key of ["items", "actions", "action_items", "records", "rows", "changes", "operations"]) {
    const v = decisionInput[key];
    if (Array.isArray(v) && v.length > 0) return v;
  }
  for (const v of Object.values(decisionInput)) {
    if (Array.isArray(v) && v.length > 0) return v;
  }
  return null;
}

// Derive the action verb (e.g. "post_note", "send_email", "create_file") from
// the decision input, for the plain-language line and the per-item tag.
function actionVerb(decisionInput: Json): string | null {
  for (const key of ["action", "tool", "operation", "verb", "kind", "type"]) {
    const v = decisionInput[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/**
 * A bold, plain-language one-liner describing what the worker wants to do.
 * Prefers the explicit approval label; otherwise composes from the verb + count.
 */
export function approvalActionLine(label: string | undefined, decisionInput: Json): string {
  if (label && label.trim()) return label.trim();
  const items = extractItems(decisionInput);
  const verb = actionVerb(decisionInput);
  const niceVerb = verb ? verb.replace(/[_-]+/g, " ") : "perform an action";
  if (items) {
    return `Wants to ${niceVerb} on ${items.length} item${items.length === 1 ? "" : "s"}`;
  }
  return `Wants to ${niceVerb}`;
}

function ItemRow({ item, verb }: { item: unknown; verb: string | null }) {
  // Object item -> a small key/value record card.
  if (isObject(item)) {
    const entries = Object.entries(item).filter(([, v]) => !isObject(v) && !Array.isArray(v));
    const titleKey = ["name", "title", "company", "record", "target", "to", "subject", "id"].find((k) => k in item);
    const title = titleKey ? asString((item as Json)[titleKey]) : asString(Object.values(item)[0]);
    const rest = entries.filter(([k]) => k !== titleKey);
    return (
      <div className="overflow-hidden rounded-[var(--radius-button)] border border-[var(--border-soft)] bg-[var(--bg-app)]">
        <div className="flex items-center gap-2 border-b border-[var(--border-soft)] px-3 py-2">
          <span className="flex-1 truncate text-[13px] font-medium">{title || "Item"}</span>
          {verb && <span className="font-mono text-[11px] text-[var(--ink-soft)]">{verb}</span>}
        </div>
        {rest.length > 0 && (
          <dl className="divide-y divide-[var(--border-soft)]">
            {rest.map(([k, v]) => (
              <div key={k} className="grid grid-cols-[120px_1fr] gap-3 px-3 py-1.5 text-xs">
                <dt className="truncate text-[var(--ink-soft)]">{k.replace(/[_-]+/g, " ")}</dt>
                <dd className="min-w-0 break-words">{asString(v)}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    );
  }
  // Scalar item -> a single plain row.
  return (
    <div className="flex items-start gap-2.5 rounded-[var(--radius-button)] border border-[var(--border-soft)] bg-[var(--bg-app)] px-3 py-2 text-[13px]">
      <span className="mt-2 size-1 shrink-0 rounded-full bg-[var(--ink-soft)]" aria-hidden />
      <span className="min-w-0 break-words">{asString(item)}</span>
    </div>
  );
}

/**
 * Render the actual items a generic approval will act on. Returns null when no
 * structured items are present (the caller then relies on the rendered preview).
 */
export function ApprovalActionItems({ decisionInput }: { decisionInput: Json }) {
  const items = extractItems(decisionInput);
  if (!items) return null;
  const verb = actionVerb(decisionInput);
  return (
    <div className="flex flex-col gap-2">
      {items.map((item, i) => (
        <ItemRow key={i} item={item} verb={verb} />
      ))}
    </div>
  );
}
