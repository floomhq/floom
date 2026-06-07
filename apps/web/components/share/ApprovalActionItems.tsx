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

function findString(item: Json, keys: string[]): string {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" || typeof value === "boolean") return String(value);
  }
  return "";
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
  if (isObject(item)) {
    const title =
      findString(item, ["name", "title", "company", "record", "target", "to", "subject", "id"]) ||
      asString(Object.values(item)[0]);
    const action =
      findString(item, ["action", "act", "change", "summary", "task", "note", "description", "operation"]) ||
      (verb ? verb.replace(/[_-]+/g, " ") : "");
    const owner = findString(item, ["owner", "assignee", "assigned_to", "user"]);
    const due = findString(item, ["due", "due_date", "date", "deadline", "when"]);
    const meta = [
      owner ? `owner: ${owner}` : "",
      due,
    ].filter(Boolean);
    const usedKeys = new Set([
      "name",
      "title",
      "company",
      "record",
      "target",
      "to",
      "subject",
      "id",
      "action",
      "act",
      "change",
      "summary",
      "task",
      "note",
      "description",
      "operation",
      "owner",
      "assignee",
      "assigned_to",
      "user",
      "due",
      "due_date",
      "date",
      "deadline",
      "when",
    ]);
    const fallbackMeta = Object.entries(item)
      .filter(([key, value]) => !usedKeys.has(key) && !isObject(value) && !Array.isArray(value))
      .slice(0, 2)
      .map(([key, value]) => `${key.replace(/[_-]+/g, " ")}: ${asString(value)}`);

    return (
      <div className="grid grid-cols-[1fr_auto] gap-2 border-b border-[var(--border-default)] px-3 py-1.5 last:border-b-0">
        <div className="min-w-0">
          <div className="truncate text-[13.5px] font-medium text-[var(--ink)]">{title || "Item"}</div>
          <div className="line-clamp-1 text-[12.5px] leading-5 text-[var(--ink-soft)]">
            {action || fallbackMeta[0] || "Pending action"}
          </div>
        </div>
        <div className="max-w-[120px] text-right text-[11.5px] leading-5 text-[var(--ink-mute)]">
          {(meta.length ? meta : fallbackMeta.slice(action ? 0 : 1)).map((value) => (
            <div key={value} className="truncate">
              {value}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2.5 border-b border-[var(--border-default)] px-3 py-1.5 text-[13px] last:border-b-0">
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
    <div className="overflow-hidden rounded-[var(--radius-button)] border border-[var(--border-default)] bg-[var(--bg-card)]">
      {items.map((item, i) => (
        <ItemRow key={i} item={item} verb={verb} />
      ))}
    </div>
  );
}
