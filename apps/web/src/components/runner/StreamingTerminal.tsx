import { useEffect, useRef } from 'react';
import type { AppDetail, PickResult } from '../../lib/types';
import { useElapsed, formatElapsed, formatEstimate } from '../../hooks/useElapsed';

interface Props {
  app: PickResult;
  lines: string[];
  onCancel?: () => void;
  /**
   * Fix 2 (2026-04-20): when passed, we surface the estimated duration
   * from `appDetail.manifest.estimated_duration_ms` (or the per-action
   * override) in the progress header so a 20–40s AI run doesn't read as
   * frozen. Optional — callers without an AppDetail (legacy paths) get
   * the pre-fix "Running…" header and a live elapsed timer only.
   */
  appDetail?: AppDetail;
  /** Action being run. Used to pick the per-action estimate, if set. */
  action?: string;
  /** When the run started. Used for the live elapsed timer. */
  startedAt?: Date | number | null;
}

export function StreamingTerminal({
  app,
  lines,
  onCancel,
  appDetail,
  action,
  startedAt,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines.length]);

  const estimate = pickEstimate(appDetail, action);
  const elapsed = useElapsed(startedAt ?? null);

  // Fix 2 (2026-04-20): surface the most recent log line as a
  // single-line "current step" above the terminal. AI apps that stream
  // progress ("Scraping brand…", "Generating slide 3/12") now feel
  // alive instead of frozen. We pick the last non-empty line so
  // [timestamp] noise lines still show something meaningful.
  const latest = pickLatestMeaningful(lines);

  return (
    <div className="assistant-turn">
      <div className="stream-header" data-testid="stream-header">
        <span className="dot-pulse">
          <span />
          <span />
          <span />
        </span>
        <span>Running {app.name}…</span>
        {elapsed != null && (
          <>
            <span className="t-dim" aria-hidden="true">
              ·
            </span>
            <span
              className="stream-elapsed"
              data-testid="stream-elapsed"
              style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--muted)' }}
              aria-label={`Elapsed ${Math.floor(elapsed / 1000)} seconds`}
            >
              {formatElapsed(elapsed)}
            </span>
          </>
        )}
        {estimate > 0 && (
          <>
            <span className="t-dim" aria-hidden="true">
              ·
            </span>
            <span
              className="stream-estimate"
              data-testid="stream-estimate"
              style={{ color: 'var(--muted)', fontSize: 12 }}
            >
              {formatEstimate(estimate)}
            </span>
          </>
        )}
      </div>

      {latest && (
        <div
          data-testid="stream-current-step"
          className="stream-current-step"
          aria-live="polite"
        >
          {latest}
        </div>
      )}

      <div className="terminal-card" ref={scrollRef}>
        {onCancel && (
          <button type="button" className="terminal-cancel" onClick={onCancel} aria-label="Cancel">
            ×
          </button>
        )}
        <pre>
          {lines.length === 0 ? (
            <span className="t-dim">Starting container…</span>
          ) : (
            lines.map((line, i) => (
              <span key={i}>
                {colorizeLine(line)}
                {'\n'}
              </span>
            ))
          )}
          <span className="caret" />
        </pre>
      </div>
    </div>
  );
}

function pickEstimate(appDetail: AppDetail | undefined, action: string | undefined): number {
  if (!appDetail?.manifest) return 0;
  const m = appDetail.manifest;
  if (action && m.actions?.[action]?.estimated_duration_ms) {
    return m.actions[action].estimated_duration_ms as number;
  }
  return typeof m.estimated_duration_ms === 'number' ? m.estimated_duration_ms : 0;
}

function pickLatestMeaningful(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    // Skip pure timestamp prefixes with nothing after — they're noise.
    const stripped = line.replace(/^\[[^\]]*\]\s*/, '').trim();
    if (stripped) return stripped.length > 120 ? stripped.slice(0, 117) + '…' : stripped;
  }
  return null;
}

function colorizeLine(line: string): React.ReactNode {
  // Light-touch terminal colorization. Matches the 4-color palette defined in
  // the wireframe CSS: floom/app tags, keys, strings, dim timestamps.
  if (/^\[.*\]/.test(line)) {
    const m = line.match(/^(\[[^\]]+\])(.*)$/);
    if (m) {
      return (
        <>
          <span className="t-dim">{m[1]}</span>
          {m[2]}
        </>
      );
    }
  }
  if (line.startsWith('ERROR') || line.startsWith('Error')) {
    return <span className="t-err">{line}</span>;
  }
  return line;
}
