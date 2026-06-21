"use client";

// #1739 — inline media in the approval / review "Proposed output".
//
// When a worker's `preview` is just a string that contains a media URL (the
// common case for "here is the rendered video / screenshot: https://…"), the
// approver had to copy the bare URL into a new tab to actually see it. Federico
// reviews videos by watching them ON the approval page, so the preview must
// render the media inline.
//
// This helper scans free text for the FIRST http(s) URL ending in a known
// video or image extension and renders an inline <video> / <img> for it, in
// ADDITION to the text the caller already shows. It is deliberately safe:
//   - only http(s) URLs pass `sanitizeHref` (no javascript:/data:/file:)
//   - <img> gets `referrerPolicy="no-referrer"` so the media host never sees
//     the app URL (referrerPolicy is not a valid <video> attribute)
//   - video has `controls` + `playsInline` and NO autoplay (no surprise sound)
// Both the in-app approval body and the public /review surface reuse it via
// ProposedOutput, so they render identically.

import { sanitizeHref } from "@/lib/safe-url";

const VIDEO_EXT = /\.(mp4|mov|webm|m4v)(?:[?#]|$)/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)(?:[?#]|$)/i;
// Match bare URLs in free text; the trailing-punctuation strip below handles
// URLs that sit at the end of a sentence ("see https://x/v.mp4.").
const URL_RE = /https?:\/\/[^\s<>"')]+/gi;

export type PreviewMediaKind = "video" | "image";

export interface PreviewMediaMatch {
  url: string;
  kind: PreviewMediaKind;
}

/**
 * Find the first safe http(s) media URL in free text. Returns null when there
 * is no media URL (the caller then renders text only). Exported for tests.
 */
export function findPreviewMedia(text: string | null | undefined): PreviewMediaMatch | null {
  if (!text) return null;
  const matches = text.match(URL_RE);
  if (!matches) return null;
  for (const raw of matches) {
    // Trim trailing sentence punctuation that the greedy match may have eaten.
    const candidate = raw.replace(/[.,;:!?)\]]+$/, "");
    const safe = sanitizeHref(candidate);
    if (!safe) continue;
    if (VIDEO_EXT.test(candidate)) return { url: safe, kind: "video" };
    if (IMAGE_EXT.test(candidate)) return { url: safe, kind: "image" };
  }
  return null;
}

/**
 * Inline media block for an approval preview. Renders nothing when `text`
 * carries no safe media URL, so it is safe to drop in unconditionally.
 */
export function PreviewMedia({ text }: { text: string | null | undefined }) {
  const media = findPreviewMedia(text);
  if (!media) return null;

  if (media.kind === "video") {
    return (
      <div className="mb-3" data-testid="preview-media-video">
        <video
          src={media.url}
          controls
          playsInline
          preload="metadata"
          className="max-h-[52vh] max-w-full rounded-[var(--radius-button)] [border:var(--bd-card)] bg-black"
        >
          <a href={media.url} target="_blank" rel="noopener noreferrer">
            Open video
          </a>
        </video>
      </div>
    );
  }

  return (
    <div className="mb-3" data-testid="preview-media-image">
      <img
        src={media.url}
        alt="Preview"
        loading="lazy"
        referrerPolicy="no-referrer"
        className="max-h-[48vh] max-w-full rounded-[var(--radius-button)] [border:var(--bd-card)] object-contain"
      />
    </div>
  );
}
