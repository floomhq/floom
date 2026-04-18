import { useState } from 'react';
import type { AppDetail, PickResult, RunRecord } from '../../lib/types';
import { pickRenderer } from '../output/rendererCascade';

function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          /* clipboard blocked; noop */
        }
      }}
      className="output-copy-btn"
      aria-label={copied ? 'Copied' : label}
    >
      {copied ? 'Copied' : label}
    </button>
  );
}

interface Props {
  app: PickResult;
  run: RunRecord;
  onIterate?: (prompt: string) => void;
  onOpenDetails?: () => void;
  /**
   * v16 renderer cascade: when provided, the manifest is consulted to
   * pick a stock library component (Layer 2) or auto-pick from declared
   * outputs (Layer 3) before falling back to the legacy inline renderer
   * (Layer 4). Optional — callers that don't have the full AppDetail
   * keep the pre-v16 behaviour unchanged.
   */
  appDetail?: AppDetail;
}

export function OutputPanel({ app, run, onIterate, onOpenDetails, appDetail }: Props) {
  const duration = run.duration_ms
    ? run.duration_ms < 1000
      ? `${run.duration_ms}ms`
      : `${(run.duration_ms / 1000).toFixed(1)}s`
    : '--';

  const isError = run.status !== 'success';

  // Layer 2 + 3 of the v16 renderer cascade. Layer 1 (custom renderer)
  // is handled in RunSurface.tsx via CustomRendererHost. Layer 4 is the
  // legacy OutputRenderer below — we fall into it when the cascade
  // returns `{ kind: 'fallback' }`.
  const cascade =
    !isError && appDetail
      ? pickRenderer({ app: appDetail, action: run.action, runOutput: run.outputs })
      : null;

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
      ) : cascade && cascade.element ? (
        cascade.element
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

  // Markdown field (also promotes a top-level `summary` string, used by
  // openkeyword / opencontext / openanalytics where it is the primary artefact).
  const markdown =
    typeof o.markdown === 'string' ? o.markdown :
    typeof o.summary === 'string' ? o.summary :
    typeof o.report === 'string' ? o.report : null;
  if (markdown) {
    return (
      <div className="app-expanded-card" style={{ position: 'relative', whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.6 }}>
        <div style={{ position: 'absolute', top: 12, right: 12 }}>
          <CopyButton value={markdown} label="Copy markdown" />
        </div>
        {markdown}
      </div>
    );
  }

  if (typeof o.preview === 'string' || typeof o.html === 'string') {
    const html = (o.preview as string) || (o.html as string);
    const downloadHtml = () => {
      const blob = new Blob([html], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `floom-output-${Date.now()}.html`;
      a.click();
      URL.revokeObjectURL(url);
    };
    return (
      <div className="app-expanded-card" style={{ position: 'relative' }}>
        <div style={{ position: 'absolute', top: 12, right: 12, display: 'flex', gap: 6, zIndex: 1 }}>
          <button type="button" className="output-copy-btn" onClick={downloadHtml}>
            Download HTML
          </button>
          <CopyButton value={html} label="Copy HTML" />
        </div>
        <div
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    );
  }

  // Fallback: pretty JSON
  const json = JSON.stringify(outputs, null, 2);
  return (
    <div
      className="app-expanded-card"
      style={{
        position: 'relative',
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 12,
        whiteSpace: 'pre-wrap',
        maxHeight: 360,
        overflow: 'auto',
      }}
    >
      <div style={{ position: 'sticky', top: 0, display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
        <CopyButton value={json} label="Copy JSON" />
      </div>
      {json}
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
  const hint = errorHint(run.error || '');
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
      {hint && (
        <p style={{ margin: '10px 0 0', fontSize: 13, color: '#5a2c12', fontWeight: 500 }}>
          {hint}
        </p>
      )}
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

function errorHint(error: string): string | null {
  if (!error) return null;
  if (/gemini-?2\.0|model.+no longer available/i.test(error)) {
    return 'Hint: this app pins a deprecated Gemini model. Ping the app author to update to gemini-3.1-pro-preview.';
  }
  if (/403|unauthori[sz]ed|forbidden/i.test(error) && /api\./i.test(error)) {
    return 'Hint: the upstream API rejected the request. Check that any required API key or bearer token secret is configured in your Floom account.';
  }
  if (/secret.+(not set|missing|required)/i.test(error) || /OPENPAPER_API_TOKEN|GEMINI_API_KEY|GOOGLE_API_KEY/.test(error)) {
    return 'Hint: this app needs a secret that is not configured. Add it under Settings → Secrets, then rerun.';
  }
  if (/could not read Username|fatal: Authentication/i.test(error)) {
    return 'Hint: this app needs a public repo URL, or a GITHUB_TOKEN secret for private repos.';
  }
  return null;
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
