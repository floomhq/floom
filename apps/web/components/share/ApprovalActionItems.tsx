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

/**
 * Whether the decision input carries structured action items (an array of
 * records / strings). Lets a caller decide whether `<ApprovalActionItems>`
 * will actually render content BEFORE committing to it — `<ApprovalActionItems>`
 * itself returns null when there are none, but a JSX element is always truthy,
 * so callers must NOT branch on the element to detect emptiness.
 */
export function hasActionItems(decisionInput: Json): boolean {
  return extractItems(decisionInput) !== null;
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
  // Object item -> a scannable record card: headline + score, a subtitle from
  // short fields, a long-text body (reason/why/…), and clickable URL fields.
  // Stays generic — any worker's items render this way, no use-case chrome.
  if (isObject(item)) {
    const scalars = Object.entries(item).filter(
      ([, v]) => !isObject(v) && !Array.isArray(v) && v != null && asString(v).trim() !== "",
    );
    const titleKey = ["name", "title", "company", "record", "target", "to", "subject", "id"].find(
      (k) => k in item && asString((item as Json)[k]).trim(),
    );
    const title = titleKey ? asString((item as Json)[titleKey]) : asString(scalars[0]?.[1] ?? "Item");
    const scoreKey = ["score", "rating", "match", "fit"].find(
      (k) => k in item && asString((item as Json)[k]).trim(),
    );
    const score = scoreKey ? asString((item as Json)[scoreKey]) : null;
    const bodyKey = ["reason", "why", "description", "summary", "body", "note", "rationale"].find(
      (k) => k in item && asString((item as Json)[k]).trim(),
    );
    const body = bodyKey ? asString((item as Json)[bodyKey]) : null;
    const isUrl = (v: unknown): v is string => typeof v === "string" && /^https?:\/\//i.test(v.trim());
    const links = scalars.filter(([k, v]) => isUrl(v) && k !== titleKey);
    const subtitle = scalars.filter(
      ([k, v]) => k !== titleKey && k !== scoreKey && k !== bodyKey && !isUrl(v),
    );
    return (
      <div className="rounded-[var(--radius-button)] [border:var(--bd-card)] bg-[var(--bg-app)] px-3.5 py-3">
        <div className="flex items-start justify-between gap-3">
          <span className="min-w-0 flex-1 text-[14px] font-medium text-[var(--ink)]">{title || "Item"}</span>
          {score != null ? (
            <span className="shrink-0 rounded-[var(--radius-pill)] bg-[var(--bg-2)] px-2 py-0.5 text-[12px] font-medium text-[var(--ink)]">
              {score}
            </span>
          ) : verb ? (
            <span className="shrink-0 font-mono text-[11px] text-[var(--ink-soft)]">{verb}</span>
          ) : null}
        </div>
        {subtitle.length > 0 && (
          <p className="mt-1 text-[12.5px] text-[var(--ink-soft)]">
            {subtitle.map(([, v]) => asString(v)).join(" · ")}
          </p>
        )}
        {body && <p className="mt-2 text-[13px] leading-relaxed text-[var(--ink)]">{body}</p>}
        {links.length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1">
            {links.map(([k, v]) => (
              <a
                key={k}
                href={v as string}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[12.5px] font-medium text-[var(--accent)] hover:underline"
              >
                {k.replace(/[_-]+/g, " ").replace(/\burl\b/i, "").trim() || "Link"} →
              </a>
            ))}
          </div>
        )}
      </div>
    );
  }
  // Scalar item -> a single plain row.
  return (
    <div className="flex items-start gap-2.5 rounded-[var(--radius-button)] [border:var(--bd-card)] bg-[var(--bg-app)] px-3 py-2 text-[13px]">
      <span className="mt-2 size-1 shrink-0 rounded-[var(--radius-pill)] bg-[var(--ink-soft)]" aria-hidden />
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