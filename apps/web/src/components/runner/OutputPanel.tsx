import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AppDetail, PickResult, RunRecord } from '../../lib/types';
import { isArrayOfFlatObjects, pickRenderer, shapePick } from '../output/rendererCascade';
import { JsonRaw } from '../output/JsonRaw';
import { Markdown } from '../output/Markdown';
import { RowTable } from '../output/RowTable';
import { ScalarBig } from '../output/ScalarBig';
import { TextBig } from '../output/TextBig';
import { sanitizeHtml } from '../../lib/sanitize';
import { useSession } from '../../hooks/useSession';

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
   * Error-taxonomy (2026-04-20): resubmit the same inputs. Passed by
   * RunSurface as a reference to its `handleRun` so the "Try again"
   * button on an upstream-outage error can retry without the user
   * having to click Run again. Absent → no retry button is rendered.
   */
  onRetry?: () => void;
  /**
   * v16 renderer cascade: when provided, the manifest is consulted to
   * pick a stock library component (Layer 2) or auto-pick from declared
   * outputs (Layer 3) before falling back to the legacy inline renderer
   * (Layer 4). Optional — callers that don't have the full AppDetail
   * keep the pre-v16 behaviour unchanged.
   */
  appDetail?: AppDetail;
}

export function OutputPanel({ app, run, onIterate, onOpenDetails, onRetry, appDetail }: Props) {
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
      ? pickRenderer({
          app: appDetail,
          action: run.action,
          runOutput: run.outputs,
          runId: run.id,
        })
      : null;

  return (
    <div className="assistant-turn">
      <div
        className="run-header"
        style={{ display: 'flex', alignItems: 'center', gap: 10 }}
        onClick={onOpenDetails}
      >
        {/* Issue #357 (2026-04-23): on a successful run, prepend a small
            green check + "Done" so the transition from the streaming
            progress card into the result reads as a positive moment for
            non-devs. Kept out of the error path so "Done" never appears
            next to an error headline. Duration stays in the meta line
            unchanged so existing dev users still see "4.2s". */}
        {!isError && run.status === 'success' && (
          <span
            data-testid="run-header-success"
            aria-label={`Done in ${duration}`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              color: 'var(--accent, #047857)',
              fontWeight: 600,
              fontSize: 13,
            }}
          >
            <svg
              viewBox="0 0 16 16"
              width={14}
              height={14}
              aria-hidden="true"
              style={{ flexShrink: 0 }}
            >
              <circle cx="8" cy="8" r="7" fill="currentColor" opacity="0.12" />
              <path
                d="M4.5 8.3l2.3 2.3 4.7-5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Done
          </span>
        )}
        {!isError && run.status === 'success' && <span className="t-dim">·</span>}
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
              {/*
                Before (PR #135): always "runtime_error" for proxied-app
                4xx, which was misleading — a 400 from the upstream is
                user input, not a Floom runtime crash. Now we surface
                the taxonomy class that matches the headline, so the
                meta line, the headline, and any bug report all agree.
              */}
              {metaLabelFor(run)}
            </span>
          </>
        )}
      </div>

      {isError ? (
        <ErrorCard run={run} appDetail={appDetail} onRetry={onRetry} />
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
    // Primitive top-level value — render it as a big value card so a
    // bare string / number / boolean response still looks like a real
    // app output rather than a monospace blob.
    if (typeof outputs === 'string') {
      return outputs.length > 0 ? <TextBig value={outputs} /> : <JsonRaw data="(no output)" />;
    }
    if (typeof outputs === 'number' || typeof outputs === 'boolean') {
      return <ScalarBig value={outputs} />;
    }
    return <JsonRaw data={outputs} />;
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
  // When a row array and prose both exist (e.g. competitor / resume demos),
  // do not return Markdown alone — v16 `pickRenderer` already handles that when
  // appDetail is present; this is for legacy callers with no manifest (#470).
  const markdown =
    typeof o.markdown === 'string' ? o.markdown :
    typeof o.summary === 'string' ? o.summary :
    typeof o.report === 'string' ? o.report : null;
  if (markdown) {
    const compositeTable =
      isArrayOfFlatObjects(o.competitors) ? { rows: o.competitors, label: 'Competitors' as const } :
      isArrayOfFlatObjects(o.ranked) ? { rows: o.ranked, label: 'Ranked candidates' as const } :
      isArrayOfFlatObjects(o.rows) ? { rows: o.rows, label: 'Rows' as const } :
      null;
    if (compositeTable) {
      return (
        <div data-renderer="composite" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <RowTable rows={compositeTable.rows} label={compositeTable.label} />
          <Markdown content={markdown} />
        </div>
      );
    }
    return <Markdown content={markdown} />;
  }

  if (typeof o.preview === 'string' || typeof o.html === 'string') {
    const html = (o.preview as string) || (o.html as string);
    return <HtmlOutput html={html} />;
  }

  // Runtime-shape fallback. When OutputPanel calls OutputRenderer it
  // has already tried the schema-driven cascade (`pickRenderer`), so
  // anything that reaches here is either a call-site without an
  // appDetail (legacy callers) OR a genuine Layer 4 fallback where
  // none of the shape heuristics matched. We still want to avoid the
  // JSON dump if we can, so run shapePick here too. If that also
  // returns null, the JsonRaw card is the honest last resort — with
  // a Copy button AND a "Why is this raw?" tooltip so the creator
  // knows they can fix it.
  const shape = shapePick(outputs);
  if (shape) return shape;

  return <JsonRaw data={outputs} />;
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
 * Run error taxonomy (2026-04-20).
 *
 * Replaces the older "severity + one headline per HTTP-status bucket"
 * scheme (PR #135) that collapsed too many root causes into the same
 * "Can't reach this app right now" message — including 400s where the
 * upstream had responded in ~400ms with a crisp "bad input" reason.
 * That version trained users to retry identical bad input instead of
 * fixing it, which the product audit flagged as the single worst
 * moment for both personas.
 *
 * Five classes, each with its own headline, sub, meta label, palette,
 * and action:
 *
 *   user_input_error     — 4xx non-auth. App rejected inputs. Focus the
 *                          first input. No retry button (won't help).
 *   auth_error           — 401/403. Missing/invalid credentials. If the
 *                          caller owns the app, link to Secrets.
 *   upstream_outage      — 5xx or timeout. Show "Try again" so retrying
 *                          identical inputs is one click away.
 *   network_unreachable  — No response at all (DNS/TLS/TCP). If owner,
 *                          link to Studio → edit base_url.
 *   floom_internal_error — Our bug. Red tint, "Report this" → GH
 *                          Issues prefilled with the run_id.
 *
 * The classifier consults `run.error_type` and `run.upstream_status`
 * first — both set by the control plane at source (see
 * services/proxied-runner.ts + services/runner.ts). When those aren't
 * populated (older runs, docker-entrypoint apps, MCP-proxied calls
 * that go through a different path), it falls through to heuristic
 * string matching on `run.error` so no run is misclassified as
 * "Can't reach this app right now" when we actually know better.
 */
type ErrorClass =
  | 'user_input_error'
  | 'auth_error'
  | 'upstream_outage'
  | 'network_unreachable'
  | 'floom_internal_error'
  | 'missing_secret_prompt'
  | 'repo_auth'
  | 'deprecated_model'
  // 2026-04-20 dead-end fix: upstream said 403 but the app doesn't declare
  // any secret (old behaviour showed "Open Secrets" → empty panel).
  // Also covers the missing-docker-image case for seed apps.
  | 'app_unavailable'
  | 'unknown';

interface ErrorCopy {
  /** Stable taxonomy slug. Persisted to a data-attribute for DOM tests. */
  klass: ErrorClass;
  /** What to render on the monospace meta line next to the duration. */
  meta: string;
  /** Big headline in the error card. */
  headline: string;
  /** Explanatory single-line sub, already interpolated with context. */
  sub: string;
  /** Severity → palette. 'platform' = red tint; everything else amber. */
  severity: 'upstream' | 'user' | 'platform';
}

interface ClassifyContext {
  /** Human display name, e.g. "base64". */
  appName: string;
  /** Host extracted from app.base_url, e.g. "api.petstore.example". */
  upstreamHost: string | null;
  /**
   * Count of secrets the manifest declares. 0 means the app has no
   * Secrets panel to route to, so routing a 401/403 to `auth_error`
   * (which shows "Open Secrets") would land on "This app doesn't
   * declare any secrets. Nothing to configure here." — a direct
   * contradiction we saw on floom.dev 2026-04-20. When 0 we degrade
   * the class to `app_unavailable` so the error card shows a neutral
   * "temporarily unavailable" message with no misleading action.
   */
  declaredSecretsCount: number;
}

function ErrorCard({
  run,
  appDetail,
  onRetry,
}: {
  run: RunRecord;
  appDetail?: AppDetail;
  onRetry?: () => void;
}) {
  const { isAuthenticated, data: session } = useSession();
  const isOwner =
    !!(isAuthenticated && session?.user?.id && appDetail?.author) &&
    session.user.id === appDetail.author;

  const ctx = useMemo<ClassifyContext>(() => {
    return {
      appName: appDetail?.name || run.app_slug || 'this app',
      // upstream_host is populated by GET /api/hub/:slug only for
      // proxied (OpenAPI-ingested) apps — docker apps have no base_url
      // so the network_unreachable sub-line falls back to "its
      // backend" instead of leaking the literal string "null".
      upstreamHost: appDetail?.upstream_host ?? null,
      // Dead-end fix (2026-04-20): the classifier needs to know whether
      // routing to the "auth_error + Open Secrets" message makes sense.
      // If the manifest declares zero secrets, the Secrets panel is
      // empty and the remediation link leads nowhere — the classifier
      // downgrades the class to `app_unavailable` instead.
      declaredSecretsCount: appDetail?.manifest?.secrets_needed?.length ?? 0,
    };
  }, [appDetail, run.app_slug]);

  const copy = classifyRunError(run, ctx);
  const palette = palettForSeverity(copy.severity);
  const rawError = run.error || '';
  const hasDetails =
    Boolean(rawError) ||
    Boolean(run.logs) ||
    run.upstream_status != null;

  // Focus the first input field on user_input_error. The inputs card
  // is a sibling in the run surface layout, so we reach across via a
  // data-testid selector rather than threading a ref prop through
  // three components. Scoped to the inputs card to avoid grabbing
  // unrelated focusables (Try again buttons, Iterate composer).
  useEffect(() => {
    if (copy.klass !== 'user_input_error') return;
    const inputsCard = document.querySelector<HTMLElement>(
      '[data-testid="app-inputs-card"]',
    );
    if (!inputsCard) return;
    const first = inputsCard.querySelector<HTMLElement>(
      'input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled])',
    );
    first?.focus({ preventScroll: true });
  }, [copy.klass, run.id]);

  const reportUrl = buildReportIssueUrl(run);
  const secretsUrl = appDetail?.slug
    ? `/me/apps/${appDetail.slug}/secrets`
    : null;
  const studioUrl = appDetail?.slug
    ? `/me/apps/${appDetail.slug}`
    : null;

  // User-input errors render as a compact, form-field-style card:
  // smaller icon, tighter padding, less visual alarm. Upstream/platform
  // errors keep the fuller alert card because they surface something the
  // user can't control.
  const isUserSeverity = copy.severity === 'user';
  return (
    <div
      data-testid="run-error-card"
      data-error-severity={copy.severity}
      data-error-class={copy.klass}
      className="app-expanded-card"
      style={{
        borderColor: palette.border,
        background: palette.bg,
        padding: isUserSeverity ? 14 : 16,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: isUserSeverity ? 10 : 12 }}>
        <WarnIcon color={palette.icon} size={isUserSeverity ? 14 : 18} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <p
            data-testid="run-error-headline"
            style={{
              margin: 0,
              fontWeight: 600,
              fontSize: isUserSeverity ? 14 : 15,
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

          {/* Per-class action row. Rendered only when an action applies
              to this class — user_input_error intentionally has none
              (retrying identical bad input won't help; we already
              focused the first field). */}
          <ErrorActions
            copy={copy}
            palette={palette}
            onRetry={onRetry}
            reportUrl={reportUrl}
            secretsUrl={isOwner ? secretsUrl : null}
            studioUrl={isOwner ? studioUrl : null}
          />

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
              {run.upstream_status != null && (
                <div
                  style={{
                    marginTop: 10,
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 11,
                    color: palette.sub,
                  }}
                  data-testid="run-error-upstream-status"
                >
                  Upstream HTTP status: {run.upstream_status}
                </div>
              )}
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
                // Issue #358: raw logs render on a light background, not the
                // old black terminal. Keeps the mono font so copy/paste still
                // looks "log-ish" without the dev-console vibe.
                <pre
                  style={{
                    marginTop: 10,
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 11,
                    background: '#f7f6f1',
                    color: 'var(--ink)',
                    border: `1px solid ${palette.border}`,
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

function ErrorActions({
  copy,
  palette,
  onRetry,
  reportUrl,
  secretsUrl,
  studioUrl,
}: {
  copy: ErrorCopy;
  palette: ReturnType<typeof palettForSeverity>;
  onRetry?: () => void;
  reportUrl: string;
  secretsUrl: string | null;
  studioUrl: string | null;
}) {
  const buttons: JSX.Element[] = [];

  // upstream_outage → Try again. Resubmits identical inputs.
  if (copy.klass === 'upstream_outage' && onRetry) {
    buttons.push(
      <button
        key="retry"
        type="button"
        onClick={onRetry}
        data-testid="run-error-action-retry"
        style={actionButtonStyle(palette)}
      >
        Try again
      </button>,
    );
  }

  // auth_error / missing_secret → link to Secrets (owner only).
  if (
    (copy.klass === 'auth_error' || copy.klass === 'missing_secret_prompt') &&
    secretsUrl
  ) {
    buttons.push(
      <Link
        key="secrets"
        to={secretsUrl}
        data-testid="run-error-action-secrets"
        style={actionLinkStyle(palette)}
      >
        Open Secrets
      </Link>,
    );
  }

  // network_unreachable → link to Studio (owner only) to edit base_url.
  if (copy.klass === 'network_unreachable' && studioUrl) {
    buttons.push(
      <Link
        key="edit-url"
        to={studioUrl}
        data-testid="run-error-action-edit-url"
        style={actionLinkStyle(palette)}
      >
        Edit app URL
      </Link>,
    );
  }

  // floom_internal_error → Report this. Prefills a GH Issue with the
  // run id so we can trace the exact failure.
  if (copy.klass === 'floom_internal_error') {
    buttons.push(
      <a
        key="report"
        href={reportUrl}
        target="_blank"
        rel="noopener noreferrer"
        data-testid="run-error-action-report"
        style={actionLinkStyle(palette)}
      >
        Report this
      </a>,
    );
  }

  if (buttons.length === 0) return null;
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 8,
        marginTop: 12,
      }}
    >
      {buttons}
    </div>
  );
}

function actionButtonStyle(palette: ReturnType<typeof palettForSeverity>) {
  return {
    fontSize: 12,
    fontWeight: 500,
    padding: '6px 12px',
    borderRadius: 8,
    border: `1px solid ${palette.border}`,
    background: 'white',
    color: palette.headline,
    cursor: 'pointer',
  } as const;
}

function actionLinkStyle(palette: ReturnType<typeof palettForSeverity>) {
  return {
    fontSize: 12,
    fontWeight: 500,
    padding: '6px 12px',
    borderRadius: 8,
    border: `1px solid ${palette.border}`,
    background: 'white',
    color: palette.headline,
    textDecoration: 'none',
    display: 'inline-block',
  } as const;
}

function buildReportIssueUrl(run: RunRecord): string {
  const runId = run.id || '(unknown)';
  const title = encodeURIComponent(`Floom internal error — run ${runId}`);
  const body = encodeURIComponent(
    [
      '**Run id:** ' + runId,
      '**App slug:** ' + (run.app_slug || 'unknown'),
      '**Error type:** ' + (run.error_type || 'unknown'),
      '',
      '**What I was doing:**',
      '',
      '',
      '**What I expected:**',
      '',
      '',
      '**What happened (paste Show details here):**',
      '',
      '```',
      (run.error || '').slice(0, 500),
      '```',
    ].join('\n'),
  );
  return `https://github.com/floomhq/floom/issues/new?title=${title}&body=${body}&labels=bug,internal-error`;
}

function WarnIcon({ color, size = 18 }: { color: string; size?: number }) {
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
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
    // Reserved for Floom-side platform bugs (floom_internal_error).
    // Slight red tint, still softer than the old #dc2626 block.
    return {
      bg: '#fef2f2',
      border: '#f1c9c9',
      headline: '#8a2a19',
      sub: '#5a2c24',
      icon: '#c2321f',
    };
  }
  if (severity === 'user') {
    // User-input errors are not alarms — the user made a fixable choice
    // and needs a calm "try again" nudge, not a warning-colored block.
    // Neutral ink on near-white so it reads as a form-field message, not
    // a full alert card. Matches the inline FieldError styling.
    return {
      bg: 'var(--card)',
      border: 'var(--line)',
      headline: 'var(--ink)',
      sub: 'var(--muted)',
      icon: '#8a6d3b',
    };
  }
  // Upstream errors — warm amber. "The server hiccuped, try again."
  return {
    bg: '#fffaf0',
    border: '#f5d8a4',
    headline: '#92400e',
    sub: '#78350f',
    icon: '#b45309',
  };
}

/**
 * Meta label shown in the monospace run-header line. Kept in sync with
 * the taxonomy so the meta, the headline, and the data-error-class
 * attribute all agree (previously the meta always said
 * "runtime_error", which was confusing for 4xx cases).
 */
function metaLabelFor(run: RunRecord): string {
  const copy = classifyRunError(run, {
    appName: run.app_slug || 'this app',
    upstreamHost: null,
    // We don't have the manifest here (meta is rendered before appDetail
    // is in scope); 0 is the safe default because `auth_error` with 0
    // declared secrets will land on the `app_unavailable` meta label,
    // which matches what the big card will render.
    declaredSecretsCount: 0,
  });
  return copy.meta;
}

/**
 * True when the app's error message looks like deliberate consumer
 * copy (single sentence, ends with a hint, no traceback / exception
 * names) and is short enough to fit in the error sub. Used to
 * promote app-supplied error text into the headline area instead
 * of swallowing it behind the generic "no clear reason" fallback.
 */
function looksLikeFriendlyAppError(error: string): string | null {
  const trimmed = error.trim();
  if (!trimmed) return null;
  if (trimmed.length > 220) return null;
  if (trimmed.includes('\n')) return null;
  // Stack-trace markers + exception names — bail out, we don't want
  // to dump these in front of consumers.
  if (/Traceback|^[A-Z][a-zA-Z]+Error:|\bat\s+\S+:\d+/.test(trimmed)) return null;
  // Bare HTTP status / generic library noise.
  if (/^HTTP \d{3}/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Maps a RunRecord to one of the five error-taxonomy classes plus a
 * ready-to-render copy block. Never surfaces the raw HTTP verb
 * ("Forbidden", "Unauthorized") and never claims "can't reach" for a
 * 4xx response — those are the two failure modes the product audit
 * flagged as the #1 worst moment on /p/:slug.
 */
export function classifyRunError(
  run: RunRecord,
  ctx: ClassifyContext,
): ErrorCopy {
  const error = run.error || '';
  const type = (run.error_type || '') as string;
  const status = run.status;
  const upstream = typeof run.upstream_status === 'number' ? run.upstream_status : null;
  const appName = ctx.appName || 'this app';
  const host = ctx.upstreamHost;

  // --- 1. Control-plane verdict wins. The proxied-runner already knows
  //        whether this was auth / 4xx / 5xx / network / timeout, so
  //        trust it and skip heuristics.

  if (type === 'user_input_error') {
    return buildUserInputError(run, appName, upstream, error);
  }
  if (type === 'auth_error') {
    // Dead-end fix (2026-04-20): if the app declares no secrets, the
    // Secrets panel is empty and "Open Secrets" leads nowhere. Downgrade
    // to app_unavailable so we show an honest "temporarily broken" state.
    if (ctx.declaredSecretsCount === 0) {
      return buildAppUnavailable(appName);
    }
    return buildAuthError(appName, upstream);
  }
  if (type === 'upstream_outage') {
    return buildUpstreamOutage(appName, upstream, /*isTimeout*/ false);
  }
  if (type === 'network_unreachable') {
    return buildNetworkUnreachable(appName, host);
  }
  if (type === 'app_unavailable') {
    return buildAppUnavailable(appName);
  }
  if (type === 'floom_internal_error') {
    return buildFloomInternalError(run, upstream);
  }

  // --- 2. Legacy taxonomy values from older runs or docker-entrypoint
  //        apps. Fall through to the nearest new class so UI copy
  //        stays consistent.

  // Timeout — from docker entrypoint or legacy proxied runs.
  if (
    status === 'timeout' ||
    type === 'timeout' ||
    /timed? ?out|timeout/i.test(error)
  ) {
    return buildUpstreamOutage(appName, upstream, /*isTimeout*/ true);
  }

  // Missing secret — the runner short-circuited before calling the upstream.
  if (
    type === 'missing_secret' ||
    /secret.+(not set|missing|required)/i.test(error) ||
    /OPENPAPER_API_TOKEN|GEMINI_API_KEY|GOOGLE_API_KEY/.test(error)
  ) {
    return {
      klass: 'missing_secret_prompt',
      meta: 'missing_secret',
      severity: 'user',
      headline: 'This app needs a secret',
      sub: `Add the missing API key under Settings → Secrets, then rerun ${appName}.`,
    };
  }

  // Build errors + OOM — both are Floom-side. Red tint.
  if (type === 'build_error') {
    return buildFloomInternalError(
      run,
      upstream,
      'We couldn’t build this app.',
      'Floom failed to prepare the app image. This is on our side.',
    );
  }
  if (type === 'oom' || /out of memory|oom|killed.*memory/i.test(error)) {
    return buildFloomInternalError(
      run,
      upstream,
      `${appName} ran out of memory.`,
      'The run exceeded available memory. This is a Floom-side limit we can raise — report it.',
    );
  }

  // --- 3. String heuristics for legacy proxied-runner output that pre-dates
  //        the taxonomy classifier. Only runs reach here; treat as a
  //        last line of defense so we don't fall through to the
  //        "can't reach" catch-all when we can tell what happened.

  const httpFromString = extractHttpStatus(error);
  const http = upstream ?? httpFromString;
  if (http !== null) {
    if (http === 401 || http === 403) {
      if (ctx.declaredSecretsCount === 0) return buildAppUnavailable(appName);
      return buildAuthError(appName, http);
    }
    if (http === 404) {
      // 404 is user_input_error: the app rejected this particular
      // path/resource the user asked for. Generic "Can't reach" was the
      // specific regression the product audit flagged.
      return buildUserInputError(run, appName, http, error);
    }
    if (http === 429) {
      return {
        klass: 'upstream_outage',
        meta: 'upstream_outage',
        severity: 'upstream',
        headline: `${appName} is being rate-limited.`,
        sub: `The upstream returned 429. Wait a minute and try again — this usually clears up on its own.`,
      };
    }
    if (http >= 400 && http < 500) {
      return buildUserInputError(run, appName, http, error);
    }
    if (http >= 500 && http < 600) {
      return buildUpstreamOutage(appName, http, /*isTimeout*/ false);
    }
  }

  // Deprecated Gemini model — actionable hint for creators.
  if (/gemini-?2\.0|model.+no longer available/i.test(error)) {
    return {
      klass: 'deprecated_model',
      meta: 'deprecated_model',
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
      klass: 'repo_auth',
      meta: 'repo_auth',
      severity: 'user',
      headline: 'Couldn’t access the app repository',
      sub:
        'Floom couldn’t clone the repo. If it’s private, add a GITHUB_TOKEN under Settings → Secrets. Otherwise the repo URL may be wrong.',
    };
  }

  // Network-ish errors that never carried a status in the message.
  if (/fetch failed|enotfound|econnrefused|econnreset|eai_again|getaddrinfo/i.test(error)) {
    return buildNetworkUnreachable(appName, host);
  }

  // --- 4. Fallbacks.

  // Legacy runtime_error / generic `status: 'error'` with no shape we
  // recognize: DO NOT claim a specific root cause (that's the bug we
  // fixed). Surface as upstream_outage with an honest sub.
  //
  // 2026-04-25 polish (Federico audit): when the app emits a friendly
  // single-line `error` message (not a stack trace, not a Python
  // exception name), surface it directly instead of the generic
  // "no clear reason" copy. The new launch demos catch their own
  // failure modes ("Couldn't extract enough readable page text",
  // "Gemini took too long", etc.) and the user benefits from seeing
  // that specific hint in the headline area.
  if (type === 'runtime_error' || status === 'error') {
    const friendly = looksLikeFriendlyAppError(error);
    if (friendly) {
      return {
        klass: 'upstream_outage',
        meta: 'upstream_outage',
        severity: 'upstream',
        headline: `${appName} couldn’t finish.`,
        sub: friendly,
      };
    }
    return {
      klass: 'upstream_outage',
      meta: 'upstream_outage',
      severity: 'upstream',
      headline: `${appName} didn’t finish.`,
      sub:
        'The run ended without a clear reason. Try again, or open details below.',
    };
  }

  return {
    klass: 'unknown',
    meta: 'unknown',
    severity: 'upstream',
    headline: 'The run didn’t complete',
    sub: 'Open details below to see what happened.',
  };
}

// ---------- per-class builders ----------

function buildUserInputError(
  run: RunRecord,
  appName: string,
  upstream: number | null,
  error: string,
): ErrorCopy {
  const msg = extractMessageFromError(error) || 'the input wasn’t accepted';
  return {
    klass: 'user_input_error',
    meta: 'user_input_error',
    severity: 'user',
    // Softer lead — no "didn't accept", no app-name duplication (the
    // surrounding card already identifies the app). Raw HTTP status +
    // upstream message lives in the collapsed "Show details" block so
    // it's available without crowding the headline.
    headline: 'Check the input and try again.',
    sub: `${msg[0]?.toUpperCase() ?? ''}${msg.slice(1)}.`,
  };
  // run + upstream kept for symmetry with other builders (future: field name).
  void run;
  void upstream;
  void appName;
}

function buildAuthError(appName: string, upstream: number | null): ErrorCopy {
  const statusNote = upstream === 401 || upstream === 403 ? ` (${upstream})` : '';
  return {
    klass: 'auth_error',
    meta: 'auth_error',
    severity: 'user',
    headline: 'This app needs authentication.',
    sub: `Floom has no credentials set for ${appName}${statusNote}. If you own this app, add a secret in Studio → Secrets.`,
  };
}

function buildUpstreamOutage(
  appName: string,
  upstream: number | null,
  isTimeout: boolean,
): ErrorCopy {
  if (isTimeout) {
    return {
      klass: 'upstream_outage',
      meta: 'timeout',
      severity: 'upstream',
      headline: `${appName} took too long.`,
      sub: `The app didn’t respond in time. This isn’t a problem with your input. Try again in a minute.`,
    };
  }
  const statusStr = upstream != null ? String(upstream) : 'a server error';
  return {
    klass: 'upstream_outage',
    meta: 'upstream_outage',
    severity: 'upstream',
    headline: `${appName} had a server error.`,
    sub: `The app’s server returned ${statusStr}. This isn’t a problem with your input. Try again in a minute.`,
  };
}

function buildNetworkUnreachable(
  appName: string,
  host: string | null,
): ErrorCopy {
  const hostStr = host ? host : 'its backend';
  return {
    klass: 'network_unreachable',
    meta: 'network_unreachable',
    severity: 'upstream',
    headline: `Can’t reach ${appName}.`,
    sub: `Floom couldn’t connect to ${hostStr}. The app may be offline, the URL may be wrong, or a firewall is blocking.`,
  };
}

/**
 * "This app is temporarily unavailable." Used for two cases:
 *  1. Docker image referenced in seed.json isn't on the host (first-party
 *     apps that were never published).
 *  2. Upstream returned 401/403 but the app declares no secrets, so the
 *     Secrets panel would be empty — the old "Open Secrets" link led to
 *     a dead-end "This app doesn't declare any secrets" page.
 *
 * No "Report" / "Open Secrets" buttons: the creator (not the user)
 * needs to fix it, and we don't have a creator-side inbox yet.
 */
function buildAppUnavailable(appName: string): ErrorCopy {
  return {
    klass: 'app_unavailable',
    meta: 'app_unavailable',
    severity: 'upstream',
    headline: `${appName} isn\u2019t available right now.`,
    sub: `The creator needs to fix or republish this app. Try another app in the meantime.`,
  };
}

function buildFloomInternalError(
  run: RunRecord,
  upstream: number | null,
  headline = 'Something broke inside Floom.',
  subBody = 'This isn’t your fault.',
): ErrorCopy {
  const statusMarker = upstream != null ? ` Upstream status ${upstream}.` : '';
  return {
    klass: 'floom_internal_error',
    meta: 'floom_internal_error',
    severity: 'platform',
    headline,
    sub: `${subBody} Error ref: ${run.id || 'unknown'}.${statusMarker}`,
  };
}

// ---------- string heuristics ----------

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

/**
 * Pull the upstream's own message out of an error like
 * `HTTP 400: bad base64 input` (the server-side
 * extractUpstreamMessage emits this shape). Falls back to null if the
 * error is just the naked status line.
 */
function extractMessageFromError(error: string): string | null {
  if (!error) return null;
  const m = error.match(/^HTTP\s+\d{3}:\s*(.+)$/s);
  if (!m) return null;
  const msg = m[1].trim();
  if (!msg) return null;
  // Cap in the UI layer too — the server already trims to 140 chars,
  // but legacy runs predating the taxonomy might carry longer blobs.
  return msg.length > 140 ? msg.slice(0, 137) + '...' : msg;
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
