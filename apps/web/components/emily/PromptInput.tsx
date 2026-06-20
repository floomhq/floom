"use client";

import { useEffect, useRef } from "react";
import { ArrowUp, Paperclip, SendHorizonal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PromptChips } from "@/components/PromptChips";
import { FileChip } from "./FileChip";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { AttachedFile } from "@/lib/emily-chat-types";

const ACCEPTED_TYPES = [
  "image/*",
  "text/*",
  "application/pdf",
  "application/json",
  "application/zip",
  "application/vnd.openxmlformats-officedocument.*",
  "application/msword",
];

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

export function PromptInput({
  value,
  onChange,
  onSubmit,
  onFilesChange,
  attachedFiles,
  placeholder,
  disabled,
  sendDisabled,
  variant = "default",
  autoFocus = false,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onFilesChange: (files: AttachedFile[]) => void;
  attachedFiles: AttachedFile[];
  placeholder?: string;
  /** Hard-disable the whole composer (textarea + attach + send). */
  disabled?: boolean;
  /**
   * B15 (Federico 2026-06-17): decouple typing from sending. When Emily is
   * streaming a reply we keep the textarea EDITABLE so the user can draft their
   * next message, and disable ONLY the send action until the stream completes.
   */
  sendDisabled?: boolean;
  /**
   * #1557 + P1-10 (Federico 2026-06-19): "landing" matches the marketing landing
   * prompt box — a FLAT, borderless composer with a labeled "Hire ↑" send
   * affordance instead of a bare arrow icon, and no "Will use / Uses" chip row.
   * Used by Emily's HOME/CREATE empty state so the in-app first prompt reads the
   * same as the landing's. The "default" variant (the bottom-anchored
   * conversation composer) keeps its existing flat-but-outlined box + icon send.
   * NOTE: rendering the detected tools as rich INLINE chips inside the editable
   * textarea (as the landing does within static prompt text) is a follow-up; the
   * landing variant simply drops the separate Uses-row to stay clean.
   */
  variant?: "default" | "landing";
  /**
   * #1698: when the composer is the PRIMARY first action (the home/create
   * empty state reached via "New worker" / `?create=1`), focus it on mount so
   * clicking "New worker" gives immediate, visible feedback (a caret lands in
   * the composer) from ANY route — never a dead click with no change.
   */
  autoFocus?: boolean;
}) {
  const isLanding = variant === "landing";
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      // B15: Enter never sends while a reply is streaming — but the keystrokes
      // before Enter still land in the textarea (it stays editable).
      if (disabled || sendDisabled) return;
      onSubmit();
    }
  };

  // Re-focus the input after streaming finishes so the user can type
  // immediately without clicking. The disabled prop removes focus while
  // the response streams in — restore it as soon as it becomes enabled.
  useEffect(() => {
    if (!disabled) {
      textareaRef.current?.focus();
    }
  }, [disabled]);

  // #1698: focus on mount when this composer is the primary first action
  // (home/create empty state via "New worker" / `?create=1`). Gives the click
  // immediate, visible feedback (caret lands here) regardless of the route the
  // user came from. Guarded by `disabled` so it never steals focus mid-stream.
  useEffect(() => {
    if (autoFocus && !disabled) {
      textareaRef.current?.focus();
    }
  }, [autoFocus, disabled]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`;
    }
  }, [value]);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? []).filter((f) => f.size <= MAX_FILE_SIZE);
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (picked.length === 0) return;
    const base: AttachedFile[] = picked.map((f) => ({
      id: `${f.name}-${f.size}-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
      name: f.name,
      size: f.size,
      type: f.type,
    }));
    // #778: upload to extract text content, then enrich (best-effort).
    let enriched = base;
    try {
      const results = await api.chat.uploadAttachments(picked);
      enriched = base.map((a, i) => ({ ...a, text: results[i]?.text ?? undefined }));
    } catch {
      /* keep metadata-only — the file chip still shows, just no content */
    }
    onFilesChange([...attachedFiles, ...enriched]);
  };

  const removeFile = (id: string) => {
    onFilesChange(attachedFiles.filter((f) => f.id !== id));
  };

  const canSend =
    (value.trim().length > 0 || attachedFiles.length > 0) && !disabled && !sendDisabled;

  return (
    <div className="space-y-2">
      {attachedFiles.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-1">
          {attachedFiles.map((f) => (
            <FileChip key={f.id} file={f} onRemove={() => removeFile(f.id)} />
          ))}
        </div>
      )}

      {/* Detected tools + capabilities in the message text (read-only here —
          the assistant decides what to wire). Same shared detector as
          /workers/new (lib/prompt-detect). #1557/P1-10: the landing variant keeps
          the composer clean (no separate Uses-row); inline tool chips are a
          follow-up. */}
      {!isLanding && <PromptChips prompt={value} className="px-1" />}

      {/* E10 (Federico 2026-06-17): flat #FBFBFC composer (bg-app), NOT the grey
          --bg-2 panel that read as an unwanted "white box" appearing on type/focus.
          default: a single subtle divider outline keeps it discoverable.
          landing (#1557/P1-10): fully FLAT, no box border at all, to match the
          marketing landing prompt box; compact padding (py-2) keeps it short. */}
      <div
        className={cn(
          // a11y #1711: the inner <textarea> is outline-none, so the composer
          // had no visible focus indicator. Move the focus affordance to the
          // wrapper: a token-based ring (--ring = --accent-line) appears whenever
          // the composer is focused, satisfying the visible-focus requirement
          // without changing the resting flat look.
          "flex items-center gap-2 rounded-xl bg-[var(--bg-app)] px-3 py-2",
          "focus-within:ring-2 focus-within:ring-[var(--ring)] focus-within:ring-offset-0",
          isLanding
            ? "[border:none]"
            : "[border:var(--bd-div)]"
        )}
      >
        {/* Attach button */}
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled}
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-40"
          title="Attach file"
          aria-label="Attach file"
        >
          <Paperclip className="size-4" />
        </button>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ACCEPTED_TYPES.join(",")}
          className="hidden"
          onChange={handleFileChange}
          aria-hidden="true"
          tabIndex={-1}
        />

        <textarea
          ref={textareaRef}
          // a11y #1711: explicit accessible name (the textarea has no visible
          // <label>; the placeholder is not an accessible name).
          aria-label="Describe the job for a new worker"
          className="flex-1 resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground min-h-[20px] max-h-[120px] overflow-auto"
          placeholder={placeholder ?? "Message Emily..."}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKey}
          rows={1}
          disabled={disabled}
        />

        {isLanding ? (
          // #1557/P1-10: labeled "Hire ↑" affordance — same shape as the marketing
          // landing's prompt CTA, not a bare arrow. Keeps the accessible name
          // "Send message" so the send action stays discoverable to AT + tests.
          <Button
            size="sm"
            className="h-7 shrink-0 gap-1.5 px-3 text-xs font-medium"
            onClick={onSubmit}
            disabled={!canSend}
            style={{ background: canSend ? "var(--accent)" : undefined, color: canSend ? "white" : undefined }}
            type="button"
            aria-label="Send message"
          >
            Hire
            <ArrowUp className="size-3.5" />
          </Button>
        ) : (
          <Button
            size="sm"
            className="h-7 w-7 p-0 shrink-0"
            onClick={onSubmit}
            disabled={!canSend}
            style={{ background: canSend ? "var(--accent)" : undefined, color: canSend ? "white" : undefined }}
            type="button"
            aria-label="Send message"
          >
            <SendHorizonal className="size-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}
