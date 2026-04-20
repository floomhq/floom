import { useEffect, useRef, useState } from 'react';
import type { PickResult } from '../../lib/types';

interface Props {
  app: PickResult;
  lines: string[];
  onCancel?: () => void;
}

/**
 * Rescue 2026-04-21 (Fix 3): elapsed timer.
 *
 * Long-running AI apps (openslides, openpaper, openblog, openanalytics)
 * take 20-40s. Before this, the running state was a bare dot-pulse and
 * users thought the page had frozen. Now the header shows a mono-
 * formatted elapsed counter ticking per second, and a "some apps take
 * 20-40 seconds" hint appears once we cross 5s.
 *
 * Intentionally minimal: no SSE stream progress, no estimated-duration
 * manifest field, no progress bar. Those are v2 per the brief.
 */
function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function useElapsed(startAt: number): number {
  const [ms, setMs] = useState(() => Date.now() - startAt);
  useEffect(() => {
    const id = window.setInterval(() => {
      setMs(Date.now() - startAt);
    }, 1000);
    return () => window.clearInterval(id);
  }, [startAt]);
  return ms;
}

export function StreamingTerminal({ app, lines, onCancel }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [startedAt] = useState(() => Date.now());
  const elapsedMs = useElapsed(startedAt);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines.length]);

  const showSlowHint = elapsedMs > 5000;

  return (
    <div className="assistant-turn">
      <div className="stream-header">
        <span className="dot-pulse">
          <span />
          <span />
          <span />
        </span>
        <span>Running {app.name}…</span>
        <span
          className="stream-elapsed"
          data-testid="stream-elapsed"
          aria-live="off"
          style={{
            marginLeft: 10,
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 12,
            color: 'var(--muted)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {formatElapsed(elapsedMs)}
        </span>
      </div>
      {showSlowHint && (
        <p
          data-testid="stream-slow-hint"
          style={{
            margin: '6px 0 10px',
            fontSize: 12,
            color: 'var(--muted)',
            lineHeight: 1.4,
          }}
        >
          Some apps take 20–40 seconds.
        </p>
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
