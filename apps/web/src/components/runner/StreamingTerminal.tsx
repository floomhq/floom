import { useEffect, useRef } from 'react';
import type { PickResult } from '../../lib/types';

interface Props {
  app: PickResult;
  lines: string[];
  onCancel?: () => void;
}

export function StreamingTerminal({ app, lines, onCancel }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines.length]);

  return (
    <div className="assistant-turn">
      <div className="stream-header">
        <span className="dot-pulse">
          <span />
          <span />
          <span />
        </span>
        <span>Running {app.name}…</span>
      </div>
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
