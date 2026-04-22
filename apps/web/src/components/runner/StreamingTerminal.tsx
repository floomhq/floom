// StreamingTerminal — non-developer-friendly run progress surface.
//
// Issue #358 (supersedes #343, launch-blocker 2026-04-22):
// Federico flagged that the previous black-terminal streaming log looked
// too techy for non-dev visitors. This component now presents:
//   - A progress bar + current step label as the primary affordance.
//   - A "Show details" disclosure (collapsed by default) that reveals a
//     light-theme log pane — NEVER the old black terminal.
//   - An elapsed timer and a gentle "some apps take 20-40 seconds" hint.
//
// The component name is kept for drop-in compatibility with RunSurface's
// existing import; its internals are a full rewrite.
//
// Step labels: logs stream as plain text lines (no structured
// `step`/`phase` events from the server yet). We derive a human label
// either from known keywords in the latest log line or by cycling
// through a minimum-3-labels sequence so the user always sees motion.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { PickResult } from '../../lib/types';

interface Props {
  app: PickResult;
  lines: string[];
  onCancel?: () => void;
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
 * Minimum rotation labels shown when we can't read anything specific
 * from the log stream. Federico's spec: "Minimum 3 labels per run so the
 * user sees SOMETHING moving." Cycled every ~4 seconds.
 */
const GENERIC_STEPS = [
  'Starting up…',
  'Calling the AI model…',
  'Parsing response…',
  'Formatting result…',
] as const;

/**
 * Map a raw log line to a friendlier phase label. Matches against
 * keywords emitted by the launch-week AI demos (lead-scorer,
 * competitor-analyzer, resume-screener) — all of which print lines like
 * `[lead-scorer] scoring N rows against ICP (…)`.
 */
export function deriveStepFromLine(line: string | undefined): string | null {
  if (!line) return null;
  const l = line.toLowerCase();
  if (/rate[- ]?limit|retry|retrying/.test(l)) return 'Retrying…';
  if (/\bsearch(ing)?|grounding|google/.test(l)) return 'Searching the web…';
  if (/\bscoring|\bscored|\bscore\b/.test(l)) return 'Scoring results…';
  if (/screening|resume|candidate/.test(l)) return 'Screening candidates…';
  if (/analy[sz]e|analy[sz]ing|compet/.test(l)) return 'Analyzing competitors…';
  if (/gemini|anthropic|openai|llm|model|prompt/.test(l)) return 'Calling the AI model…';
  if (/pars(e|ing)|json/.test(l)) return 'Parsing response…';
  if (/format|render|wrap/.test(l)) return 'Formatting result…';
  if (/read(ing)?|load(ing)?|csv|file/.test(l)) return 'Reading input…';
  if (/start|boot|init/.test(l)) return 'Starting up…';
  return null;
}

/**
 * Pick the label to display. Priority:
 *   1. A keyword match on the latest log line (most informative).
 *   2. The generic cycle, indexed by elapsed time so it advances even
 *      when no logs are flowing (indeterminate-looking but still moving).
 */
export function pickStepLabel(
  lines: string[],
  elapsedMs: number,
): string {
  const latest = lines[lines.length - 1];
  const fromLine = deriveStepFromLine(latest);
  if (fromLine) return fromLine;
  const idx = Math.min(
    GENERIC_STEPS.length - 1,
    Math.floor(elapsedMs / 4000),
  );
  return GENERIC_STEPS[idx];
}

export function StreamingTerminal({ app, lines, onCancel }: Props) {
  const [startedAt] = useState(() => Date.now());
  const elapsedMs = useElapsed(startedAt);
  const logScrollRef = useRef<HTMLDivElement>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const stepLabel = useMemo(() => pickStepLabel(lines, elapsedMs), [lines, elapsedMs]);
  const showSlowHint = elapsedMs > 5000;

  // Only auto-scroll the details pane when it's open — otherwise we
  // thrash layout for nothing. Scrolls to the bottom as new lines land.
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
      aria-live="polite"
    >
      <div className="run-progress-header">
        <div className="run-progress-title">
          <span className="run-progress-spinner" aria-hidden="true" />
          <span>Running {app.name}</span>
        </div>
        <div
          className="run-progress-elapsed"
          data-testid="stream-elapsed"
          aria-live="off"
        >
          {formatElapsed(elapsedMs)}
        </div>
      </div>

      <div
        className="run-progress-bar"
        role="progressbar"
        aria-busy="true"
        aria-label={stepLabel}
      >
        <div className="run-progress-bar-fill" aria-hidden="true" />
      </div>

      <div className="run-progress-step" data-testid="run-progress-step">
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
        <details
          className="run-progress-details"
          data-testid="run-progress-details"
          open={detailsOpen}
          onToggle={(e) =>
            setDetailsOpen((e.target as HTMLDetailsElement).open)
          }
        >
          <summary className="run-progress-details-summary">
            {detailsOpen ? 'Hide details' : 'Show details'}
          </summary>
          <div
            className="run-progress-log"
            data-testid="run-progress-log"
            ref={logScrollRef}
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
        </details>

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

export const __test__ = { deriveStepFromLine, pickStepLabel, GENERIC_STEPS };
