import { useMemo, useState } from 'react';
import type { AppDetail, PickResult, RunRecord } from '../../lib/types';
import { pickRenderer } from '../output/rendererCascade';
import { sanitizeHtml } from '../../lib/sanitize';

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
            <span
              data-testid="run-header-error-meta"
              style={{
                color: 'var(--muted)',
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 12,
              }}
            >
              {run.error_type || run.status}
            </span>
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

      {/* Iterate block is opt-in (manifest.render.refinable === true).
          RunSurface hides the composer by passing onIterate=undefined. */}
      {onIterate && (
        <>
          <p className="iterate-label">Iterate</p>
          <IterateInput onSubmit={onIterate} />
        </>
      )}
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
    return <HtmlOutput html={html} />;
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

// Creator apps can legitimately return `type: "html"` outputs (e.g. a
// rendered email preview, a generated slide deck). We inline that HTML
// into the runner surface, so a malicious creator could otherwise run
// scripts in the Floom origin and steal the viewer's session. DOMPurify
// strips `<script>`, inline event handlers, `javascript:` URLs, form
// actions, etc. before the string reaches dangerouslySetInnerHTML.
//
// The Download / Copy buttons still operate on the raw HTML so the
// user can inspect what was returned — just not let it execute in our
// origin.
function HtmlOutput({ html }: { html: string }) {
  const safeHtml = useMemo(() => sanitizeHtml(html), [html]);
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
        dangerouslySetInnerHTML={{ __html: safeHtml }}
      />
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

/**
 * v16 ErrorCard redesign (2026-04-19).
 *
 * Old design showed a red block with the raw error_type ("runtime_error")
 * and the verbatim server message ("HTTP 403: Forbidden"). That was
 * scary, technically misleading (a 403 from an upstream is often
 * rate-limit / geoblock / expired key, not a permission issue), and
 * conflated expected upstream failures with Floom platform bugs.
 *
 * New behavior:
 *  - Most errors use a warm amber palette (not red). Red is reserved for
 *    the severity === 'platform' branch (future: OOM, build errors, our
 *    own server crashing). Today the classifier only returns 'upstream'
 *    or 'user' which both render amber.
 *  - Classify the error via `classifyRunError` into a small set of
 *    categories, each with a human headline + sub-line.
 *  - Never render "Forbidden" verbatim. The raw message moves into a
 *    collapsed "Show details" disclosure alongside logs.
 *  - Icon: warning triangle (not an X), muted tone.
 */
interface ErrorCopy {
  headline: string;
  sub: string;
  severity: 'upstream' | 'user' | 'platform';
}

function ErrorCard({ run }: { run: RunRecord }) {
  const copy = classifyRunError(run);
  const palette = palettForSeverity(copy.severity);
  const rawError = run.error || '';
  const hasDetails = Boolean(rawError) || Boolean(run.logs);
  return (
    <div
      data-testid="run-error-card"
      data-error-severity={copy.severity}
      className="app-expanded-card"
      style={{
        borderColor: palette.border,
        background: palette.bg,
        padding: 16,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <WarnIcon color={palette.icon} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <p
            data-testid="run-error-headline"
            style={{
              margin: 0,
              fontWeight: 600,
              fontSize: 15,
              color: palette.headline,
              lineHeight: 1.35,
            }}
          >
            {copy.headline}
          </p>
          <p
            data-testid="run-error-sub"
            style={{
              margin: '6px 0 0',
              fontSize: 13,
              color: palette.sub,
              lineHeight: 1.5,
            }}
          >
            {copy.sub}
          </p>
          {hasDetails && (
            <details style={{ marginTop: 14 }} data-testid="run-error-details">
              <summary
                style={{
                  cursor: 'pointer',
                  fontSize: 12,
                  color: palette.sub,
                  fontWeight: 500,
                }}
              >
                Show details
              </summary>
              {rawError && (
                <div
                  style={{
                    marginTop: 10,
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 11,
                    color: palette.sub,
                    background: 'rgba(0,0,0,0.035)',
                    border: `1px solid ${palette.border}`,
                    borderRadius: 8,
                    padding: 10,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                  data-testid="run-error-raw"
                >
                  {rawError}
                </div>
              )}
              {run.logs && (
                <pre
                  style={{
                    marginTop: 10,
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
              )}
            </details>
          )}
        </div>
      </div>
    </div>
  );
}

function WarnIcon({ color }: { color: string }) {
  return (
    <svg
      aria-hidden
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0, marginTop: 1 }}
    >
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function palettForSeverity(severity: ErrorCopy['severity']) {
  if (severity === 'platform') {
    // Reserved for Floom-side platform bugs. Slight red tint, but still
    // softer than the old #dc2626 block.
    return {
      bg: '#fef2f2',
      border: '#f1c9c9',
      headline: '#8a2a19',
      sub: '#5a2c24',
      icon: '#c2321f',
    };
  }
  // Upstream / user errors — warm amber. Matches the "this usually
  // clears up" framing: informational, not alarming.
  return {
    bg: '#fffaf0',
    border: '#f5d8a4',
    headline: '#92400e',
    sub: '#78350f',
    icon: '#b45309',
  };
}

/**
 * Maps a RunRecord to a user-facing headline + sub-line. Never surfaces
 * the raw HTTP verb ("Forbidden", "Unauthorized"): those are scary and
 * often technically wrong (upstreams return 403 for rate-limit, geo
 * blocks, expired API keys, etc.).
 *
 * Exported (via module-local scope) primarily so the tree-shaken output
 * still carries the strings; DOM tests assert on the headlines.
 */
export function classifyRunError(run: RunRecord): ErrorCopy {
  const error = run.error || '';
  const type = run.error_type || '';
  const status = run.status;

  // Timeout — both the status and the dedicated error_type.
  if (status === 'timeout' || type === 'timeout' || /timed? ?out|timeout/i.test(error)) {
    return {
      severity: 'upstream',
      headline: 'This run took too long',
      sub:
        'The app didn’t finish in the allowed time. Try again, or check if the inputs are larger than usual.',
    };
  }

  // Missing secret — explicit error_type from the server classifier, or
  // text heuristic. Treated as "user": the caller can fix by adding a
  // secret, so we guide them to Settings.
  if (
    type === 'missing_secret' ||
    /secret.+(not set|missing|required)/i.test(error) ||
    /OPENPAPER_API_TOKEN|GEMINI_API_KEY|GOOGLE_API_KEY/.test(error)
  ) {
    return {
      severity: 'user',
      headline: 'This app needs a secret',
      sub:
        'Add the missing API key under Settings → Secrets, then rerun. The app couldn’t reach its backend without it.',
    };
  }

  // Build errors — Floom side failed to prepare the app image.
  if (type === 'build_error') {
    return {
      severity: 'platform',
      headline: 'We couldn’t build this app',
      sub:
        'Floom failed to prepare the app image. This is on our side — try again shortly, or report it if it persists.',
    };
  }

  // OOM — the app ran out of memory. Borderline platform vs upstream;
  // render amber so callers retrying smaller inputs get a fix path.
  if (type === 'oom' || /out of memory|oom|killed.*memory/i.test(error)) {
    return {
      severity: 'upstream',
      headline: 'The app ran out of memory',
      sub:
        'The run exceeded the available memory. Try smaller inputs, or ping the app author if this keeps happening.',
    };
  }

  // Validation — inputs didn't match the schema. Try to pull the
  // field name from the message ("field 'foo': required").
  if (
    type === 'validation_error' ||
    /validation[_ ]error|invalid (input|value|parameter)|required field|missing field/i.test(
      error,
    )
  ) {
    const field = extractField(error);
    return {
      severity: 'user',
      headline: 'Those inputs aren’t accepted',
      sub: field
        ? `The input "${field}" didn’t match what the app expected. Adjust it and try again.`
        : 'One or more inputs didn’t match what the app expected. Adjust them and try again.',
    };
  }

  // HTTP-specific headlines. Pulled from the raw error body, which is
  // typically shaped like "HTTP 403: Forbidden" or "status 502 from
  // upstream". We never show the verb to the user.
  const http = extractHttpStatus(error);
  if (http !== null) {
    if (http === 401) {
      return {
        severity: 'user',
        headline: 'This app needs authentication',
        sub:
          'The upstream API rejected the request without credentials. Add the required key under Settings → Secrets and try again.',
      };
    }
    if (http === 403) {
      // 403 is frequently rate-limit / geoblock / expired key. Do NOT
      // say "Forbidden" — it's misleading and alarming.
      return {
        severity: 'upstream',
        headline: 'Can’t reach this app right now',
        sub:
          'The app returned 403. This is usually a temporary block or rate limit on the upstream service and clears up in a few minutes.',
      };
    }
    if (http === 404) {
      return {
        severity: 'upstream',
        headline: 'The app couldn’t find that',
        sub: 'The upstream returned 404. The resource the app was looking for may have moved or been removed.',
      };
    }
    if (http === 429) {
      return {
        severity: 'upstream',
        headline: 'The app is being rate-limited',
        sub:
          'The upstream returned 429. Wait a minute and retry — this usually clears up on its own.',
      };
    }
    if (http >= 400 && http < 500) {
      return {
        severity: 'upstream',
        headline: 'Can’t reach this app right now',
        sub: `The app returned ${http}. This usually clears up in a few minutes.`,
      };
    }
    if (http >= 500 && http < 600) {
      return {
        severity: 'upstream',
        headline: 'The app had a server error',
        sub: `The upstream service returned ${http}. Try again shortly — this is on the app’s side, not yours.`,
      };
    }
  }

  // Deprecated Gemini model — actionable hint for creators.
  if (/gemini-?2\.0|model.+no longer available/i.test(error)) {
    return {
      severity: 'user',
      headline: 'This app pins a deprecated model',
      sub:
        'The app references a Gemini model that’s been retired. Ping the app author to update it (gemini-3.1-pro-preview).',
    };
  }

  // Git auth — creator misconfigured the repo or it's private without
  // a GITHUB_TOKEN.
  if (/could not read Username|fatal: Authentication/i.test(error)) {
    return {
      severity: 'user',
      headline: 'Couldn’t access the app repository',
      sub:
        'Floom couldn’t clone the repo. If it’s private, add a GITHUB_TOKEN under Settings → Secrets. Otherwise the repo URL may be wrong.',
    };
  }

  // Generic runtime_error without a more specific classification. Today
  // these are overwhelmingly upstream app failures, so stay amber.
  if (type === 'runtime_error' || status === 'error') {
    return {
      severity: 'upstream',
      headline: 'Something went wrong running this app',
      sub:
        'The app didn’t finish. This is usually a hiccup on the app’s side — try again, or open details below.',
    };
  }

  // Last-resort fallback — unknown status.
  return {
    severity: 'upstream',
    headline: 'The run didn’t complete',
    sub: 'Open details below to see what happened.',
  };
}

function extractHttpStatus(error: string): number | null {
  if (!error) return null;
  // "HTTP 403", "HTTP 403: Forbidden", "status 502", "returned 429",
  // "http_status=503". Broad but bounded.
  const m = error.match(/\b(?:http[_ :-]*|status[_ :-]*|returned[_ :-]*)?(\d{3})\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (n < 100 || n > 599) return null;
  return n;
}

function extractField(error: string): string | null {
  // "field 'foo'", "field \"foo\"", "'foo' is required", "property foo",
  // "input: foo" — first capture wins.
  const quoted = error.match(/['"`]([a-zA-Z_][\w.-]{0,40})['"`]/);
  if (quoted) return quoted[1];
  const bare = error.match(/\b(?:field|property|input|parameter)s?\s+([a-zA-Z_][\w.-]{0,40})/i);
  if (bare) return bare[1];
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
