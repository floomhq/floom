"use client";

/**
 * X4 — richer approval review: a free-text reject reason is not enough.
 *
 * Two first-cut annotation surfaces, both feeding ONE structured payload that is
 * sent with the approve/reject decision and persisted on the approval/run:
 *
 *   1. TextHighlightAnnotator — select a range of a text/markdown artifact, add a
 *      comment on that selection. The span is visually marked and listed.
 *   2. ScreenshotAnnotator   — upload a screenshot, caption it, and click to drop
 *      pin+comment markers on the image (basic pins, not freehand drawing).
 *
 * Collected shape (mirrors the backend `_sanitize_annotations` contract):
 *   { text: [{quote, comment}], images: [{url, caption, pins:[{x,y,comment}]}] }
 *
 * Image `url` is the content-addressed `/uploads/<sha>` ref returned by the
 * approval-scoped upload endpoint; the reviewer previews from a local object URL
 * so the anonymous signed-link reviewer never needs to read the blob back.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MessageSquarePlus, Plus, Trash2, Upload, X } from "lucide-react";
import type {
  ApprovalAnnotations,
  ImageAnnotation,
  ImagePin,
  TextAnnotation,
} from "@/lib/types";

let _localId = 0;
function nextLocalId(): string {
  _localId += 1;
  return `anno-${_localId}-${Date.now().toString(36)}`;
}

export function emptyAnnotations(): ApprovalAnnotations {
  return { text: [], images: [] };
}

export function hasAnnotations(a: ApprovalAnnotations | null | undefined): boolean {
  if (!a) return false;
  return (a.text?.length ?? 0) > 0 || (a.images?.length ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Text highlight + comment
// ---------------------------------------------------------------------------

type TextItem = TextAnnotation & { _id: string };

export function TextHighlightAnnotator({
  text,
  items,
  onChange,
}: {
  text: string;
  items: TextItem[];
  onChange: (items: TextItem[]) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [selection, setSelection] = useState<string>("");
  const [draft, setDraft] = useState("");

  const captureSelection = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      setSelection("");
      return;
    }
    const container = containerRef.current;
    if (!container) return;
    // Only accept selections that live inside the artifact text, not the panel.
    const anchorOk = sel.anchorNode && container.contains(sel.anchorNode);
    const focusOk = sel.focusNode && container.contains(sel.focusNode);
    if (!anchorOk || !focusOk) {
      setSelection("");
      return;
    }
    const value = sel.toString().trim();
    setSelection(value.slice(0, 8000));
  }, []);

  const addComment = useCallback(() => {
    const quote = selection.trim();
    const comment = draft.trim();
    if (!quote && !comment) return;
    onChange([...items, { _id: nextLocalId(), quote, comment }]);
    setDraft("");
    setSelection("");
    window.getSelection()?.removeAllRanges();
  }, [draft, items, onChange, selection]);

  const removeItem = useCallback(
    (id: string) => onChange(items.filter((item) => item._id !== id)),
    [items, onChange]
  );

  // Highlight every quoted span inside the rendered text. First match wins per
  // quote — good enough for a v1 reviewer pass; exact-substring, case-sensitive.
  const segments = useMemo(() => {
    const quotes = items.map((item) => item.quote).filter(Boolean);
    if (quotes.length === 0) return [{ text, highlighted: false }];
    // Build a set of [start,end) ranges, earliest occurrence of each quote.
    const ranges: Array<[number, number]> = [];
    for (const quote of quotes) {
      const idx = text.indexOf(quote);
      if (idx >= 0) ranges.push([idx, idx + quote.length]);
    }
    ranges.sort((a, b) => a[0] - b[0]);
    const out: Array<{ text: string; highlighted: boolean }> = [];
    let cursor = 0;
    for (const [start, end] of ranges) {
      if (start < cursor) continue; // overlap: skip
      if (start > cursor) out.push({ text: text.slice(cursor, start), highlighted: false });
      out.push({ text: text.slice(start, end), highlighted: true });
      cursor = end;
    }
    if (cursor < text.length) out.push({ text: text.slice(cursor), highlighted: false });
    return out;
  }, [items, text]);

  return (
    <div className="grid gap-3 md:grid-cols-[1fr_280px]">
      <div
        ref={containerRef}
        onMouseUp={captureSelection}
        onKeyUp={captureSelection}
        className="relative max-h-[42vh] select-text overflow-auto whitespace-pre-wrap rounded-[var(--radius-ui)] bg-[var(--bg-2)] p-4 text-sm leading-6 text-[var(--ink)]"
      >
        {segments.map((seg, i) =>
          seg.highlighted ? (
            <mark
              key={i}
              className="rounded-[var(--radius-ui)] bg-[var(--accent-soft)] px-0.5 text-[var(--ink)]"
            >
              {seg.text}
            </mark>
          ) : (
            <span key={i}>{seg.text}</span>
          )
        )}
      </div>

      <div className="flex flex-col gap-3">
        <div className="rounded-[var(--radius-ui)] bg-[var(--paper)] p-3">
          <p className="text-xs font-medium text-[var(--ink)]">
            {selection ? "Comment on selection" : "Select text to comment"}
          </p>
          {selection && (
            <p className="mt-1 line-clamp-3 rounded bg-[var(--bg-2)] px-2 py-1 text-xs italic text-[var(--ink-soft)]">
              “{selection}”
            </p>
          )}
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={!selection}
            placeholder="What should change here?"
            className="mt-2 min-h-16 w-full rounded-[var(--radius-ui)] bg-[var(--bg-2)] px-2 py-1.5 text-xs text-[var(--ink)] focus:outline-none focus: disabled:opacity-50"
          />
          <button
            type="button"
            onClick={addComment}
            disabled={!selection || !draft.trim()}
            className="mt-2 inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-[var(--radius-ui)] bg-[var(--primary)] px-3 text-xs font-medium text-[var(--primary-text)] disabled:opacity-40"
          >
            <MessageSquarePlus className="h-3.5 w-3.5" />
            Add comment
          </button>
        </div>

        {items.length > 0 && (
          <ul className="flex flex-col gap-2">
            {items.map((item) => (
              <li
                key={item._id}
                className="rounded-[var(--radius-ui)] bg-[var(--paper)] p-2.5 text-xs"
              >
                {item.quote && (
                  <p className="line-clamp-2 italic text-[var(--ink-soft)]">“{item.quote}”</p>
                )}
                <div className="mt-1 flex items-start justify-between gap-2">
                  <p className="text-[var(--ink)]">{item.comment || <span className="text-[var(--ink-faint)]">(no comment)</span>}</p>
                  <button
                    type="button"
                    onClick={() => removeItem(item._id)}
                    aria-label="Remove comment"
                    className="shrink-0 text-[var(--ink-faint)] hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Screenshot upload + pin comment
// ---------------------------------------------------------------------------

export type ScreenshotDraft = ImageAnnotation & {
  _id: string;
  // Local object URL for preview — the anonymous reviewer never reads the
  // persisted blob back, so we render from the file they picked.
  _previewUrl: string;
};

export function ScreenshotAnnotator({
  images,
  onChange,
  onUpload,
  uploading,
}: {
  images: ScreenshotDraft[];
  onChange: (images: ScreenshotDraft[]) => void;
  onUpload: (file: File) => Promise<{ url: string; previewUrl: string } | null>;
  uploading: boolean;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Revoke preview object URLs on unmount to avoid leaking blob: handles.
  useEffect(() => {
    return () => {
      for (const img of images) {
        if (img._previewUrl) URL.revokeObjectURL(img._previewUrl);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFile = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      const result = await onUpload(file);
      if (!result) return;
      onChange([
        ...images,
        { _id: nextLocalId(), url: result.url, caption: "", pins: [], _previewUrl: result.previewUrl },
      ]);
    },
    [images, onChange, onUpload]
  );

  const updateImage = useCallback(
    (id: string, patch: Partial<ScreenshotDraft>) =>
      onChange(images.map((img) => (img._id === id ? { ...img, ...patch } : img))),
    [images, onChange]
  );

  const removeImage = useCallback(
    (id: string) => {
      const target = images.find((img) => img._id === id);
      if (target?._previewUrl) URL.revokeObjectURL(target._previewUrl);
      onChange(images.filter((img) => img._id !== id));
    },
    [images, onChange]
  );

  const addPin = useCallback(
    (id: string, event: React.MouseEvent<HTMLImageElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const x = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
      const y = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
      const img = images.find((i) => i._id === id);
      if (!img) return;
      const pin: ImagePin = { x: Number(x.toFixed(4)), y: Number(y.toFixed(4)), comment: "" };
      updateImage(id, { pins: [...img.pins, pin] });
    },
    [images, updateImage]
  );

  const updatePin = useCallback(
    (id: string, index: number, comment: string) => {
      const img = images.find((i) => i._id === id);
      if (!img) return;
      const pins = img.pins.map((pin, i) => (i === index ? { ...pin, comment } : pin));
      updateImage(id, { pins });
    },
    [images, updateImage]
  );

  const removePin = useCallback(
    (id: string, index: number) => {
      const img = images.find((i) => i._id === id);
      if (!img) return;
      updateImage(id, { pins: img.pins.filter((_, i) => i !== index) });
    },
    [images, updateImage]
  );

  return (
    <div className="flex flex-col gap-3">
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          void handleFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={uploading}
        className="inline-flex h-9 w-fit items-center gap-1.5 rounded-[var(--radius-ui)] px-3 text-sm font-medium text-[var(--ink)] hover:bg-[var(--bg-2)] disabled:opacity-50"
      >
        <Upload className="h-4 w-4" />
        {uploading ? "Uploading…" : "Attach screenshot"}
      </button>

      {images.map((img) => (
        <div
          key={img._id}
          className="overflow-hidden rounded-[var(--radius-ui)] bg-[var(--paper)]"
        >
          <div className="flex items-center justify-between gap-2 [border-bottom:var(--bd-div)] px-3 py-2">
            <input
              value={img.caption}
              onChange={(e) => updateImage(img._id, { caption: e.target.value.slice(0, 8000) })}
              placeholder="Caption (optional)"
              className="min-w-0 flex-1 bg-transparent text-xs text-[var(--ink)] focus:outline-none"
            />
            <button
              type="button"
              onClick={() => removeImage(img._id)}
              aria-label="Remove screenshot"
              className="shrink-0 text-[var(--ink-faint)] hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="relative bg-[var(--bg-2)] p-3">
            <div className="relative inline-block max-w-full">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={img._previewUrl}
                alt={img.caption || "Review screenshot"}
                onClick={(e) => addPin(img._id, e)}
                className="max-h-[40vh] max-w-full cursor-crosshair rounded-[var(--radius-ui)] object-contain"
              />
              {img.pins.map((pin, i) => (
                <span
                  key={i}
                  style={{ left: `${pin.x * 100}%`, top: `${pin.y * 100}%` }}
                  className="absolute -ml-3 -mt-3 flex h-6 w-6 items-center justify-center rounded-[var(--radius-ui)] bg-[var(--primary)] text-[11px] font-semibold text-[var(--primary-text)] shadow"
                >
                  {i + 1}
                </span>
              ))}
            </div>
            <p className="mt-2 inline-flex items-center gap-1 text-[11px] text-[var(--ink-soft)]">
              <Plus className="h-3 w-3" />
              Click the image to drop a numbered comment pin.
            </p>
            {img.pins.length > 0 && (
              <ul className="mt-2 flex flex-col gap-1.5">
                {img.pins.map((pin, i) => (
                  <li key={i} className="flex items-center gap-2">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--radius-ui)] bg-[var(--primary)] text-[10px] font-semibold text-[var(--primary-text)]">
                      {i + 1}
                    </span>
                    <input
                      value={pin.comment}
                      onChange={(e) => updatePin(img._id, i, e.target.value.slice(0, 8000))}
                      placeholder="Comment for this pin"
                      className="min-w-0 flex-1 rounded-[var(--radius-ui)] bg-[var(--bg-2)] px-2 py-1 text-xs text-[var(--ink)] focus:outline-none focus:"
                    />
                    <button
                      type="button"
                      onClick={() => removePin(img._id, i)}
                      aria-label="Remove pin"
                      className="shrink-0 text-[var(--ink-faint)] hover:text-destructive"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Read-only viewer — what the OWNER sees on an already-annotated approval/run.
// ---------------------------------------------------------------------------

export function AnnotationsViewer({
  annotations,
  resolveImageUrl,
}: {
  annotations: ApprovalAnnotations;
  /** Turn a persisted /uploads/<sha> ref into a fetchable URL (owner-authed). */
  resolveImageUrl?: (ref: string) => string;
}) {
  const text = annotations.text ?? [];
  const images = annotations.images ?? [];
  if (text.length === 0 && images.length === 0) return null;

  return (
    <div>
      <h2 className="text-sm font-medium text-[var(--ink)]">Reviewer feedback</h2>
      <div className="mt-2 space-y-3">
        {text.length > 0 && (
          <ul className="flex flex-col gap-2">
            {text.map((item, i) => (
              <li
                key={i}
                className="rounded-[var(--radius-ui)] bg-[var(--bg-2)] p-3 text-xs"
              >
                {item.quote && <p className="italic text-[var(--ink-soft)]">“{item.quote}”</p>}
                {item.comment && <p className="mt-1 text-[var(--ink)]">{item.comment}</p>}
              </li>
            ))}
          </ul>
        )}
        {images.map((img, i) => (
          <div
            key={i}
            className="overflow-hidden rounded-[var(--radius-ui)] bg-[var(--bg-2)]"
          >
            {img.caption && (
              <p className="[border-bottom:var(--bd-div)] px-3 py-2 text-xs text-[var(--ink)]">
                {img.caption}
              </p>
            )}
            <div className="relative inline-block max-w-full p-3">
              <div className="relative inline-block">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={resolveImageUrl ? resolveImageUrl(img.url) : img.url}
                  alt={img.caption || "Reviewer screenshot"}
                  className="max-h-[40vh] max-w-full rounded-[var(--radius-ui)] object-contain"
                />
                {(img.pins ?? []).map((pin, p) => (
                  <span
                    key={p}
                    style={{ left: `${pin.x * 100}%`, top: `${pin.y * 100}%` }}
                    className="absolute -ml-3 -mt-3 flex h-6 w-6 items-center justify-center rounded-[var(--radius-ui)] bg-[var(--primary)] text-[11px] font-semibold text-[var(--primary-text)] shadow"
                  >
                    {p + 1}
                  </span>
                ))}
              </div>
              {(img.pins ?? []).length > 0 && (
                <ul className="mt-2 flex flex-col gap-1 text-xs">
                  {img.pins.map((pin, p) => (
                    <li key={p} className="flex items-start gap-2">
                      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--radius-ui)] bg-[var(--primary)] text-[10px] font-semibold text-[var(--primary-text)]">
                        {p + 1}
                      </span>
                      <span className="text-[var(--ink)]">{pin.comment || <span className="text-[var(--ink-faint)]">(no comment)</span>}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Strip local-only fields before sending annotations with the decision. */
export function serializeAnnotations(
  text: TextItem[],
  images: ScreenshotDraft[]
): ApprovalAnnotations {
  return {
    text: text
      .map((item) => ({ quote: item.quote, comment: item.comment }))
      .filter((item) => item.quote || item.comment),
    images: images.map((img) => ({
      url: img.url,
      caption: img.caption,
      pins: img.pins.map((pin) => ({ x: pin.x, y: pin.y, comment: pin.comment })),
    })),
  };
}

export type { TextItem };
