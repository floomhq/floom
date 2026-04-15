import type { PickResult, RunRecord } from '../../lib/types';

interface Props {
  app: PickResult;
  run: RunRecord;
  onIterate?: (prompt: string) => void;
  onOpenDetails?: () => void;
}

export function OutputPanel({ app, run, onIterate, onOpenDetails }: Props) {
  const duration = run.duration_ms
    ? run.duration_ms < 1000
      ? `${run.duration_ms}ms`
      : `${(run.duration_ms / 1000).toFixed(1)}s`
    : '--';

  const isError = run.status !== 'success';

  return (
    <div className="assistant-turn">
      <div
        className="run-header"
        style={{ display: 'flex', alignItems: 'center', gap: 10 }}
        onClick={onOpenDetails}
      >
        <span>{app.name}</span>
        <span className="t-dim">·</span>
        <span>{duration}</span>
        {isError && (
          <>
            <span className="t-dim">·</span>
            <span style={{ color: 'var(--warning)' }}>{run.status}</span>
          </>
        )}
      </div>

      {isError ? (
        <ErrorCard run={run} />
      ) : (
        <OutputRenderer outputs={run.outputs} />
      )}

      <p className="iterate-label">Iterate</p>
      <IterateInput onSubmit={onIterate} />
    </div>
  );
}

function OutputRenderer({ outputs }: { outputs: unknown }) {
  if (!outputs || typeof outputs !== 'object') {
    return (
      <div
        className="app-expanded-card"
        style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, whiteSpace: 'pre-wrap' }}
      >
        {String(outputs ?? '(no output)')}
      </div>
    );
  }

  // Special-case FlyFast results: flight cards.
  const o = outputs as Record<string, unknown>;
  if (Array.isArray(o.flights)) {
    return (
      <div>
        {(o.flights as Array<Record<string, unknown>>).slice(0, 5).map((flight, i) => (
          <FlightCard key={i} flight={flight as Record<string, unknown>} />
        ))}
        {(o.flights as unknown[]).length > 5 && (
          <p
            style={{
              fontSize: 12,
              color: 'var(--muted)',
              fontFamily: "'JetBrains Mono', monospace",
              marginTop: 4,
            }}
          >
            + {(o.flights as unknown[]).length - 5} more
          </p>
        )}
      </div>
    );
  }

  // Markdown field
  if (typeof o.markdown === 'string') {
    return (
      <div className="app-expanded-card" style={{ whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.6 }}>
        {o.markdown}
      </div>
    );
  }

  if (typeof o.preview === 'string' || typeof o.html === 'string') {
    const html = (o.preview as string) || (o.html as string);
    return (
      <div className="app-expanded-card">
        <div
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    );
  }

  // Fallback: pretty JSON
  return (
    <div
      className="app-expanded-card"
      style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 12,
        whiteSpace: 'pre-wrap',
        maxHeight: 360,
        overflow: 'auto',
      }}
    >
      {JSON.stringify(outputs, null, 2)}
    </div>
  );
}

function FlightCard({ flight }: { flight: Record<string, unknown> }) {
  const price = flight.price as number | undefined;
  const currency = (flight.currency as string) || 'EUR';
  const legs = (flight.legs as Array<Record<string, unknown>>) || [];
  const firstLeg = legs[0] || {};
  const route = (flight.route as string) || `${firstLeg.from} -> ${firstLeg.to}`;
  const airline = (firstLeg.airline as string) || 'Unknown';

  return (
    <div className="flight-card">
      <div className="flight-price">
        {currency === 'EUR' ? '€' : '$'}
        {price ?? '--'}
      </div>
      <div className="flight-info">
        <div className="flight-airline">{airline}</div>
        <div className="flight-route">{route}</div>
        {typeof firstLeg.departs === 'string' ? (
          <div className="flight-return">
            {new Date(firstLeg.departs).toLocaleDateString()} ·{' '}
            {new Date(firstLeg.departs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ErrorCard({ run }: { run: RunRecord }) {
  return (
    <div
      className="app-expanded-card"
      style={{ borderColor: '#e7d0c9', background: '#fdf4f1' }}
    >
      <p style={{ margin: 0, fontWeight: 600, color: '#9a3a19' }}>
        {run.error_type || run.status}
      </p>
      <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--muted)' }}>
        {run.error || 'The run failed without an error message.'}
      </p>
      {run.logs && (
        <details style={{ marginTop: 12 }}>
          <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--muted)' }}>
            Show logs
          </summary>
          <pre
            style={{
              marginTop: 8,
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 11,
              background: 'var(--terminal-bg)',
              color: 'var(--terminal-ink)',
              padding: 12,
              borderRadius: 8,
              maxHeight: 240,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
            }}
          >
            {run.logs}
          </pre>
        </details>
      )}
    </div>
  );
}

function IterateInput({ onSubmit }: { onSubmit?: (prompt: string) => void }) {
  if (!onSubmit) return null;
  return (
    <form
      className="iterate-input-wrap"
      onSubmit={(e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const input = form.elements.namedItem('iterate') as HTMLInputElement;
        const v = input.value.trim();
        if (!v) return;
        onSubmit(v);
        input.value = '';
      }}
    >
      <input name="iterate" type="text" className="iterate-input" placeholder="Refine your request…" />
      <button type="submit" className="iterate-btn">
        Refine
      </button>
    </form>
  );
}
