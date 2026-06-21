"use client";

// Round-09 (r9) — the canonical approval review surface, shared by the in-app
// inbox detail (app/approvals/ApprovalsCollection.tsx) AND the shared-link /
// multi-item review page (app/approvals/review/page.tsx) so in-app and a shared
// link read IDENTICALLY (the approved share-approval design).
//
// Layout: a multi-item pager (one link, several approvals) + a confident hero
// (eyebrow + "Awaiting your decision" + label + who/when/worker + cost) + a
// two-column grid — your response LEFT (comment, attach, who/why/run/expires,
// Approve / Reject) and the proposed output RIGHT, rendered as itself (an email
// To/Subject/body when typed that way, else the real ApprovalActionItems /
// GenericOutput). Reuses real primitives + tokens; accent on links only; no
// borders (hairline dividers); no avatars; no amber as a second accent.

import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight, Paperclip } from "lucide-react";
import { GenericOutput } from "@/components/generic-output";
import { ApprovalActionItems, hasActionItems } from "@/components/share/ApprovalActionItems";
import { PreviewMedia } from "@/components/share/PreviewMedia";
import { sanitizeOutputText } from "@/lib/strip-citations";
import type { ApprovalRow } from "@/lib/types";

/* ---- helpers --------------------------------------------------------------- */

function parseDecisionInput(raw?: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function asString(v: unknown): string {
  if (v == null) return "";
  return sanitizeOutputText(typeof v === "string" ? v : String(v));
}

function formatRelative(iso?: string): string {
  if (!iso) return "";
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `${Math.floor(hours / 24)} day${Math.floor(hours / 24) === 1 ? "" : "s"} ago`;
}

function formatExpiry(iso?: string | null): string | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return null;
  if (ms <= 0) return "expired";
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return `${Math.max(1, Math.floor(ms / 60_000))}m`;
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function costLine(a: ApprovalRow): string | null {
  const parts: string[] = [];
  if (typeof a.tokens_so_far === "number" && a.tokens_so_far > 0) {
    const t = a.tokens_so_far;
    parts.push(t >= 1000 ? `${(t / 1000).toFixed(1)}k tokens` : `${t} tokens`);
  }
  if (typeof a.cost_usd_so_far === "number" && a.cost_usd_so_far > 0) {
    parts.push(`$${a.cost_usd_so_far < 0.01 ? a.cost_usd_so_far.toFixed(4) : a.cost_usd_so_far.toFixed(2)}`);
  }
  return parts.length ? `${parts.join(" · ")} so far` : null;
}

/** Email-shaped typed preview (preview_payload.{to,subject,body}). */
function emailPayload(a: ApprovalRow): { to?: string; subject?: string; body?: string } | null {
  const p = a.preview_payload;
  const typed = (a.type ?? a.preview_type ?? "").toLowerCase();
  if (p && typeof p === "object" && !Array.isArray(p)) {
    const o = p as Record<string, unknown>;
    const to = asString(o.to ?? o.recipient ?? o.email);
    const subject = asString(o.subject ?? o.title);
    const body = asString(o.body ?? o.text ?? o.content ?? o.message);
    if (typed.includes("email") || to || subject) return { to, subject, body };
  }
  return null;
}

/* ---- proposed output (RIGHT) ----------------------------------------------- */

function ProposedOutput({ approval }: { approval: ApprovalRow }) {
  const di = parseDecisionInput(approval.decision_input_json);
  const email = emailPayload(approval);

  if (email) {
    return (
      <div className="c-appr-proposed">
        <p className="addr">
          {email.to && (
            <>
              <b>To</b> {email.to}
              <br />
            </>
          )}
          {email.subject && (
            <>
              <b>Subject</b> {email.subject}
            </>
          )}
        </p>
        {email.body && (
          <div className="body">
            {email.body.split(/\n{2,}/).map((para, i) => (
              <p key={i}>{para}</p>
            ))}
          </div>
        )}
        <PreviewMedia text={email.body ?? ""} />
      </div>
    );
  }

  // Structured items (records / actions) render as the real ApprovalActionItems.
  // Guard on whether items actually exist — `<ApprovalActionItems>` is a JSX
  // element (always truthy) even when it renders null, so branching on the
  // element would swallow the `preview` and the empty-state fallback below.
  if (hasActionItems(di)) {
    return (
      <div className="c-appr-proposed">
        <ApprovalActionItems decisionInput={di} />
      </div>
    );
  }

  // Otherwise the preview string, rendered as itself.
  if (approval.preview && approval.preview.trim()) {
    const t = (approval.type ?? approval.preview_type ?? inferPreviewType(approval.preview)) as string;
    return (
      <div className="c-appr-proposed">
        <PreviewMedia text={sanitizeOutputText(approval.preview)} />
        <GenericOutput type={t} value={sanitizeOutputText(approval.preview)} />
      </div>
    );
  }
  return <p className="c-appr-proposed" style={{ color: "var(--muted-foreground)" }}>No proposed output attached to this request.</p>;
}

function inferPreviewType(preview: string): string {
  const t = preview.trim();
  if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) return "json";
  if (/^#{1,3}\s|\n[-*]\s|\|.+\|/.test(t)) return "markdown";
  return "text";
}

/* ---- pager ----------------------------------------------------------------- */

function Pager({
  worker,
  index,
  total,
  onPrev,
  onNext,
  disabled,
}: {
  worker: string;
  index: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="c-appr-pager">
      <span className="where">
        Approval {index + 1} <span className="of">of {total}</span>
        {worker && (
          <>
            {" · "}
            <b>{worker}</b>
          </>
        )}
      </span>
      <div className="right">
        <div className="c-appr-dots" aria-hidden>
          {Array.from({ length: Math.min(total, 12) }).map((_, i) => (
            <i key={i} className={i === index ? "on" : ""} />
          ))}
        </div>
        <div className="c-appr-nav">
          <button
            type="button"
            className="c-appr-pgbtn"
            aria-label="Previous approval"
            onClick={onPrev}
            disabled={disabled || index === 0}
          >
            <ChevronLeft size={15} />
          </button>
          <button
            type="button"
            className="c-appr-pgbtn"
            aria-label="Next approval"
            onClick={onNext}
            disabled={disabled || index >= total - 1}
          >
            <ChevronRight size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---- the shared review body ------------------------------------------------ */

export interface ApprovalReviewBodyProps {
  approval: ApprovalRow;
  /** Plain-language action line (composed by the caller via approvalActionLine). */
  actionLine: string;
  /**
   * Hide worker/run internals (worker name + id, run id, "by worker X").
   * Set on the external signed-link reviewer view so it reads like a recruiter
   * reviewing a shortlist, not an operator approving a worker action. Defaults
   * to false so the internal owner view is unchanged.
   */
  hideInternals?: boolean;
  /** Pager position over sibling approvals (one link, several items). */
  index: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
  /** Reviewer comment (controlled). */
  comment: string;
  onComment: (value: string) => void;
  /** Whether a comment left on APPROVE is persisted for this approval kind. */
  approveKeepsComment: boolean;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
  /** Attach affordance (optional — wired by the caller's upload handler). */
  onAttach?: () => void;
  /** Run/worker links (in-app) or plain text (shared link). */
  runLink?: ReactNode;
  workerLink?: ReactNode;
  /** Footnote: in-app vs shared-link copy. */
  footnote?: ReactNode;
  /** Optional rich proposed-output override (e.g. the review page's file preview). */
  proposedOverride?: ReactNode;
  /** Optional extra content under the LEFT response column (e.g. attached chips, prior annotations). */
  leftExtra?: ReactNode;
}

export function ApprovalReviewBody({
  approval,
  actionLine,
  hideInternals = false,
  index,
  total,
  onPrev,
  onNext,
  comment,
  onComment,
  approveKeepsComment,
  busy,
  onApprove,
  onReject,
  onAttach,
  runLink,
  workerLink,
  footnote,
  proposedOverride,
  leftExtra,
}: ApprovalReviewBodyProps) {
  const worker = approval.worker_name ?? approval.worker_id;
  const cost = costLine(approval);
  const expiry = formatExpiry(approval.expires_at);

  return (
    <div style={{ maxWidth: 820, margin: "0 auto" }}>
      <Pager
        worker={hideInternals ? "" : worker}
        index={index}
        total={total}
        onPrev={onPrev}
        onNext={onNext}
        disabled={busy}
      />

      {/* HERO — the ask, confident */}
      <div className="c-appr-hero">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span className="c-appr-eyebrow">Approval requested</span>
          <span className="c-appr-wait">
            <span className="dot" /> Awaiting your decision
          </span>
        </div>
        <h2 className="c-appr-title">{actionLine}</h2>
        <p className="c-appr-meta">
          Requested {formatRelative(approval.created_at)}
          {!hideInternals && (
            <>
              {" by worker "}
              <b>{worker}</b>
            </>
          )}
          {cost && (
            <>
              {" · "}
              {cost}
            </>
          )}
        </p>
      </div>

      <hr style={{ border: 0, borderTop: "var(--bd-div)", margin: "0 0 18px" }} />

      {/* TWO COLUMN: response LEFT, proposed output RIGHT */}
      <div className="c-appr-grid">
        <div className="col-left">
          <p className="c-appr-sech">Your response</p>
          <textarea
            className="c-appr-comment"
            value={comment}
            onChange={(e) => onComment(e.target.value)}
            placeholder="Add a comment with your decision, or leave a note…"
            rows={3}
            disabled={busy}
          />
          {comment.trim() && !approveKeepsComment && (
            <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--muted-foreground)", lineHeight: 1.5 }}>
              This worker approves via a tool callback that cannot store a comment. Your note is sent only if you reject.
            </p>
          )}
          {onAttach && (
            <button type="button" className="c-appr-attach" onClick={onAttach} disabled={busy}>
              <Paperclip size={15} /> Attach a file or screenshot
            </button>
          )}

          <dl className="c-appr-kv">
            {!hideInternals && (
              <>
                <dt>Worker</dt>
                <dd>{workerLink ?? worker}</dd>
                <dt>Run</dt>
                <dd>{runLink ?? `#${approval.run_id}`}</dd>
              </>
            )}
            <dt>Why</dt>
            <dd>{approval.label?.trim() ? approval.label : actionLine}</dd>
            {expiry && (
              <>
                <dt>Expires</dt>
                <dd>{expiry === "expired" ? "Expired" : `in ${expiry}`}</dd>
              </>
            )}
          </dl>

          <div className="c-appr-decide">
            <button
              type="button"
              className="c-addbtn"
              style={{ padding: "8px 18px", fontSize: 13 }}
              onClick={onApprove}
              disabled={busy}
            >
              {busy ? "Working" : total > 1 ? "Approve this" : "Approve"}
            </button>
            <button
              type="button"
              className="c-vpill"
              style={{ padding: "8px 18px", color: "var(--warning)", borderColor: "var(--warning)" }}
              onClick={onReject}
              disabled={busy}
            >
              {total > 1 ? "Reject this" : "Reject"}
            </button>
          </div>

          {leftExtra}
        </div>

        <div className="col-right">
          <p className="c-appr-sech">Proposed output</p>
          {proposedOverride ?? <ProposedOutput approval={approval} />}
        </div>
      </div>

      {footnote && <p className="c-appr-foot">{footnote}</p>}
    </div>
  );
}
