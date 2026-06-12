"use client";

import { useEffect, useRef } from "react";
import { Paperclip, SendHorizonal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PromptChips } from "@/components/PromptChips";
import { FileChip } from "./FileChip";
import { api } from "@/lib/api";
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
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onFilesChange: (files: AttachedFile[]) => void;
  attachedFiles: AttachedFile[];
  placeholder?: string;
  disabled?: boolean;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
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

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 140)}px`;
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

  const canSend = (value.trim().length > 0 || attachedFiles.length > 0) && !disabled;

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
          /workers/new (lib/prompt-detect). */}
      <PromptChips prompt={value} className="px-1" />

      <div className="flex items-center gap-2 rounded-xl [border:var(--bd-card)] bg-background px-3 py-2.5 shadow-sm focus-within:[border:var(--bd-card)] transition-shadow">
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
          className="flex-1 resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground min-h-[20px] max-h-[140px] overflow-auto"
          placeholder={placeholder ?? "Message Emily..."}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKey}
          rows={1}
          disabled={disabled}
        />

        <Button
          size="sm"
          className="h-7 w-7 p-0 shrink-0"
          onClick={onSubmit}
          disabled={!canSend}
          style={{ background: canSend ? "#59AAF8" : undefined, color: canSend ? "white" : undefined }}
          type="button"
          aria-label="Send message"
        >
          <SendHorizonal className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
