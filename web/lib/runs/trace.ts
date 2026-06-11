// Runs detail — Trace tab + inline file-open helpers (APP-UI-V4-SPEC §4, rule #5).
import type { TranscriptRow } from "@/lib/types";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;

/** Rule #5 / §4: "PNG artifacts render as images." True for image file names. */
export function isImageFile(name: string | undefined | null): boolean {
  return !!name && IMAGE_EXT.test(name.trim());
}

export interface TraceStep {
  label: string;
  content: string;
}

function summarize(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

/**
 * Steps for the Trace tab. The transcript carries no per-step timestamps (no
 * structured field — backend reality), so we present labeled steps with a
 * content summary; durations are shown from the run-level/log timeline instead
 * of fabricated per step.
 */
export function traceSteps(transcript: TranscriptRow[] | undefined): TraceStep[] {
  if (!transcript) return [];
  return transcript.map((s, i) => ({
    label: s.role || s.type || s.name || `Step ${i + 1}`,
    content: summarize(s.content ?? s.arguments).slice(0, 400),
  }));
}
