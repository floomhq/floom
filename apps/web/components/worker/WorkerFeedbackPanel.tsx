"use client";

import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { formatRelative } from "@/lib/formatters";
import type { WorkerFeedback } from "@/lib/types";

interface WorkerFeedbackPanelProps {
  workerId: string;
  /** Show the compose box (anyone who can see the worker — SPEC §12). */
  canLeave: boolean;
  /** Show delete on every item (owner/admin moderation). Authors can always
   *  delete their own server-side; this just controls the visible affordance. */
  canModerate?: boolean;
}

/**
 * Worker feedback (SPEC §12): a lightweight comment thread anyone who can see
 * the worker can post to, surfaced to the owner. Backed by
 * GET/POST/DELETE /workers/{id}/feedback.
 */
export function WorkerFeedbackPanel({ workerId, canLeave, canModerate }: WorkerFeedbackPanelProps) {
  const [items, setItems] = useState<WorkerFeedback[] | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () =>
    api.workers.feedback
      .list(workerId)
      .then(setItems)
      .catch(() => setItems([]));

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workerId]);

  const submit = async () => {
    const content = text.trim();
    if (!content || busy) return;
    setBusy(true);
    try {
      const created = await api.workers.feedback.create(workerId, content);
      setItems((prev) => [...(prev ?? []), created]);
      setText("");
    } catch {
      toast.error("Could not post your feedback.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await api.workers.feedback.remove(workerId, id);
      setItems((prev) => (prev ?? []).filter((f) => f.id !== id));
    } catch {
      toast.error("Could not remove this feedback.");
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 620 }}>
      <div className="c-ltable">
        {items === null && <div style={{ ...muted, padding: 14 }}>Loading…</div>}
        {items?.length === 0 && (
          <div style={{ ...muted, padding: 14 }}>
            No feedback yet.{canLeave ? " Be the first to leave a note." : ""}
          </div>
        )}
        {items?.map((f) => (
          <div key={f.id} className="c-lrow" style={{ gridTemplateColumns: "1fr auto", alignItems: "start" }}>
            <div className="c-lprimary" style={{ flexDirection: "column", alignItems: "flex-start", gap: 3 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                <span className="nm">{f.author_name || "Someone"}</span>
                <span style={{ ...muted, fontSize: 11.5 }}>{formatRelative(f.created_at)}</span>
              </div>
              <div style={{ whiteSpace: "pre-wrap", color: "var(--ink-soft)" }}>{f.content}</div>
            </div>
            {canModerate && (
              <button
                type="button"
                aria-label="Delete feedback"
                className="x"
                onClick={() => void remove(f.id)}
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
        ))}
      </div>

      {canLeave && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <textarea
            aria-label="Leave feedback"
            className="c-srch"
            style={{ maxWidth: "none", minHeight: 72, padding: "10px 12px", resize: "vertical" }}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Leave feedback for the owner — what's wrong or what to change…"
            disabled={busy}
          />
          <div>
            <button type="button" className="c-addbtn" disabled={busy || !text.trim()} onClick={() => void submit()}>
              {busy ? "Posting…" : "Post feedback"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const muted: React.CSSProperties = { color: "var(--muted-foreground)" };
