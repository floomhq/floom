// StreamingTerminal — non-developer-friendly run progress surface.
//
// Issue #357 (launch-blocker 2026-04-22, supersedes the #358 polish):
// Federico flagged that the previous black-terminal streaming log looked
// too techy for non-dev visitors. This component presents:
//   - A progress bar + human-friendly current step label as the primary
//     affordance.
//   - A "Show technical details" disclosure button (collapsed by default
//     for new visitors, persisted in localStorage for devs) that reveals
//     a light-theme log pane — NEVER the old black terminal.
//   - An elapsed timer and a gentle "some apps take 20-40 seconds" hint.
//
// The component name is kept for drop-in compatibility with RunSurface's
// existing import; its internals are a full rewrite from the pre-#358
// black terminal. The API contract (props + exported test helpers) is
// unchanged from #358 — only the presentation layer was touched.
//
// Step labels: logs stream as plain text lines (no structured `step`
// events from the server yet). We derive a human label from known
// keywords in the latest log line (Docker-oriented patterns for the
// Floom runtime + LLM-oriented patterns for the launch-week demos) and
// fall back to "Working on it…" when nothing matches. A follow-up
// server change (tracked in comments) should emit a structured `step`
// field so we can stop relying on log-pattern heuristics.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PickResult } from '../../lib/types';

interface Props {
  app: PickResult;
  lines: string[];
  onCancel?: () => void;
}

/**
 * localStorage key for the "Show technical details" toggle. Persisting
 * this lets the small slice of devs who want the log open see it open
 * on every subsequent run — non-devs default to collapsed and never
 * touch the key. Scoped to the whole app (not per-run) so it follows
 * the visitor, not the app they happen to be running.
 */
const DETAILS_STORAGE_KEY = 'floom.run-progress.details-open';

function readPersistedDetails(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(DETAILS_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writePersistedDetails(open: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    if (open) {
      window.localStorage.setItem(DETAILS_STORAGE_KEY, '1');
    } else {
      window.localStorage.removeItem(DETAILS_STORAGE_KEY);
    }
  } catch {
    /* storage blocked (private mode, quota); expander still works in-session */
  }
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function useElapsed(startAt: number): number {
  const [ms, setMs] = useState(() => Date.now() - startAt);
  useEffect(() => {
    const id = window.setInterval(() => setMs(Date.now() - startAt), 1000);
    return () => window.clearInterval(id);
  }, [startAt]);
  return ms;
}

/**
 * Default label shown while we haven't matched anything useful in the
 * log stream yet. Spec (issue #357): "Default label: Working on it".
 */
const DEFAULT_STEP_LABEL = 'Working on it…';

/**
 * Map a raw log line to a friendlier phase label. Ordered roughly by
 * specificity: Docker/runtime phases first (they're the earliest thing
 * the visitor sees on a cold start), then the LLM/domain-specific
 * matches for the launch-week demos (lead-scorer, competitor-analyzer,
 * resume-screener). The first match wins.
 *
 * Heuristic by design: the server currently only emits raw stdout/stderr
 * lines. A follow-up should add a structured `step` event so we can
 * stop pattern-matching on free text. Tracked in the PR body.
 */
export function deriveStepFromLine(line: string | undefined): string | null {
  if (!line) return null;
  const l = line.toLowerCase();

  // ── Runtime / Docker lifecycle (Floom runner) ──────────────────────────
  if (/pulling (?:image|from)|downloading|image pull/.test(l)) {
    return 'Setting up runtime…';
  }
  if (/docker run|starting container|container start|creating container/.test(l)) {
    return 'Starting your app…';
  }
  if (/listening on|server (?:ready|started|listening)|ready on http|uvicorn running|now listening/.test(l)) {
    return 'App is ready';
  }
  if (/\b(get|post|put|patch|delete)\s+\/run\b|handler (?:entry|started|invoked)|invoking handler/.test(l)) {
    return 'Running your code…';
  }
  if (/run completed|run finished|exit(?:ed)? with code 0|finaliz/.test(l)) {
    return 'Finalizing results…';
  }

  // ── Transient failure modes ────────────────────────────────────────────
  if (/rate[- ]?limit|429|retry(?:ing)?|backoff/.test(l)) return 'Retrying…';

  // ── LLM / domain steps (launch-week demos) ─────────────────────────────
  if (/\bsearch(?:ing)?|grounding|google/.test(l)) return 'Searching the web…';
  if (/\bscoring|\bscored|\bscore\b/.test(l)) return 'Scoring results…';
  if (/screening|resume|candidate/.test(l)) return 'Screening candidates…';
  if (/analy[sz]e|analy[sz]ing|compet/.test(l)) return 'Analyzing competitors…';
  if (/gemini|anthropic|openai|llm|\bmodel\b|prompt/.test(l)) return 'Calling the AI model…';
  if (/pars(?:e|ing)|json/.test(l)) return 'Parsing response…';
  if (/format|render|wrap/.test(l)) return 'Formatting result…';
  if (/read(?:ing)?|load(?:ing)?|csv|\bfile\b/.test(l)) return 'Reading input…';
  if (/\bstart|\bboot|\binit/.test(l)) return 'Starting up…';

  return null;
}

/**
 * Pick the label to display. We walk the tail of the log stream from
 * the newest line backwards and use the first line that yields a match
 * — this keeps the label stuck on something meaningful ("Running your
 * code…") even when the last few lines are unmatched chatter from the
 * app itself. Falls back to "Working on it…" if nothing in the tail
 * maps, which keeps the surface reassuring for non-devs who would
 * otherwise see a bare bar with no context.
 */
export function pickStepLabel(lines: string[]): string {
  const tailStart = Math.max(0, lines.length - 12);
  for (let i = lines.length - 1; i >= tailStart; i--) {
    const match = deriveStepFromLine(lines[i]);
    if (match) return match;
  }
  return DEFAULT_STEP_LABEL;
}

export function StreamingTerminal({ app, lines, onCancel }: Props) {
  const [startedAt] = useState(() => Date.now());
  const elapsedMs = useElapsed(startedAt);
  const logScrollRef = useRef<HTMLDivElement>(null);
  const [detailsOpen, setDetailsOpen] = useState<boolean>(() =>
    readPersistedDetails(),
  );

  const stepLabel = useMemo(() => pickStepLabel(lines), [lines]);
  const showSlowHint = elapsedMs > 5000;

  const toggleDetails = useCallback(() => {
    setDetailsOpen((prev) => {
      const next = !prev;
      writePersistedDetails(next);
      return next;
    });
  }, []);

  // Only auto-scroll the log pane when it's open — otherwise we thrash
  // layout for nothing. Scrolls to the bottom as new lines land.
  useEffect(() => {
    if (!detailsOpen) return;
    const el = logScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length, detailsOpen]);

  return (
    <div
      className="run-progress"
      data-testid="run-progress"
      data-phase="streaming"
    >
      <div className="run-progress-header">
        <div className="run-progress-title">
          <span className="run-progress-spinner" aria-hidden="true" />
          <span>Running {app.name}</span>
        </div>
        <div
          className="run-progress-elapsed"
          data-testid="stream-elapsed"
          aria-label={`Elapsed ${formatElapsed(elapsedMs)}`}
        >
          {formatElapsed(elapsedMs)}
        </div>
      </div>

      {/* a11y 2026-04-22 (#357): indeterminate progress bar. aria-valuemin
          and aria-valuemax are declared so assistive tech can read the
          role correctly; aria-valuenow is deliberately omitted because
          we don't know the total step count yet (spec: indeterminate
          when the server doesn't emit a structured step total). */}
      <div
        className="run-progress-bar"
        role="progressbar"
        aria-busy="true"
        aria-label="Run progress"
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="run-progress-bar-fill" aria-hidden="true" />
      </div>

      {/* Current step label lives in its own polite live region so screen
          readers announce the transition (Setting up runtime → Starting
          your app → App is ready) without re-reading the whole card. */}
      <div
        className="run-progress-step"
        data-testid="run-progress-step"
        aria-live="polite"
        aria-atomic="true"
      >
        {stepLabel}
      </div>

      {showSlowHint && (
        <p
          className="run-progress-hint"
          data-testid="stream-slow-hint"
        >
          Some apps take 20–40 seconds.
        </p>
      )}

      <div className="run-progress-footer">
        {/* Expander is a proper <button> (#357) so it gets focus ring,
            keyboard activation, and aria-expanded/aria-controls without
            relying on <details>'s quirky toggle event. State persists
            in localStorage — devs who open it stay open on every run,
            non-devs (the default) never see it. */}
        <div className="run-progress-details">
          <button
            type="button"
            className="run-progress-details-summary"
            data-testid="run-progress-details-toggle"
            aria-expanded={detailsOpen}
            aria-controls="run-progress-log-region"
            onClick={toggleDetails}
          >
            <span className="run-progress-details-caret" aria-hidden="true">
              ›
            </span>
            {detailsOpen ? 'Hide technical details' : 'Show technical details'}
          </button>
          {detailsOpen && (
            <div
              id="run-progress-log-region"
              className="run-progress-log"
              data-testid="run-progress-log"
              ref={logScrollRef}
              role="region"
              aria-label="Raw run log"
            >
              {lines.length === 0 ? (
                <p className="run-progress-log-empty">
                  Waiting for the app to start…
                </p>
              ) : (
                <pre className="run-progress-log-pre">
                  {lines.map((line, i) => (
                    <span key={i}>
                      {line}
                      {'\n'}
                    </span>
                  ))}
                </pre>
              )}
            </div>
          )}
        </div>

        {onCancel && (
          <button
            type="button"
            className="run-progress-cancel"
            data-testid="run-progress-cancel"
            onClick={onCancel}
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

export const __test__ = {
  deriveStepFromLine,
  pickStepLabel,
  DEFAULT_STEP_LABEL,
  DETAILS_STORAGE_KEY,
  readPersistedDetails,
  writePersistedDetails,
};
