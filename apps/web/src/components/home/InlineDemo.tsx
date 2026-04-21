/**
 * InlineDemo — "Try it with a real app."
 *
 * Hits /api/run for the `lead-scorer` launch hero (swapped from
 * jwt-decode 2026-04-21 per MEMORY.md launch comms: AI lead scoring is
 * the flagship demo) and polls /api/run/:id until it finishes. This is
 * NOT a screenshot and NOT a GIF: the visitor sees a real Floom run
 * happen in front of them, without leaving the landing page.
 *
 * We keep the surface minimal on purpose. Both inputs are pre-filled —
 * a 5-company CSV (Stripe / Vercel / Linear / Cursor / Anthropic) and a
 * short ICP description — so Run works one-click. lead-scorer's
 * main.py::_load_rows accepts an inline CSV string when the path isn't
 * a real file, so we pass the CSV text directly as `data` and skip the
 * file-upload dance for the landing hero.
 *
 * Rate limit: server gates anon runs at 5 per IP per 24h (see
 * apps/server/src/lib/byok-gate.ts). On the 6th attempt the API returns
 * 429 `byok_required`; we pop the BYOKModal so the visitor can paste
 * their own Gemini key and keep going.
 *
 * The JWT decoder still lives at /p/jwt-decode and is linked from the
 * featured-apps section further down the page.
 */
import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Play } from 'lucide-react';
import { startRun, getRun, ApiError } from '../../api/client';
import type { RunRecord } from '../../lib/types';
import { SectionEyebrow } from './SectionEyebrow';
import { BYOKModal } from '../BYOKModal';

interface DemoState {
  status: 'idle' | 'running' | 'done' | 'error';
  runId: string | null;
  output: unknown;
  error: string | null;
  durationMs: number | null;
}

const INITIAL: DemoState = {
  status: 'idle',
  runId: null,
  output: null,
  error: null,
  durationMs: null,
};

// Pre-filled 5-row lead list used for the zero-click demo. Real,
// recognisable SaaS companies so the scored output is immediately
// "yep, that's right" when the visitor reads it. Industry and notes
// columns give the scorer enough context to avoid 0-scoring everything
// as "unknown", even in slow-network conditions where the grounded
// search might time out.
const SAMPLE_CSV = [
  'company,industry,notes',
  'Stripe,payments,API-first global payments infrastructure',
  'Vercel,dev tools,Next.js hosting platform',
  'Linear,productivity,Issue tracker for software teams',
  'Cursor,dev tools,AI-native code editor',
  'Anthropic,AI,Frontier AI research & Claude API',
].join('\n');

const SAMPLE_ICP =
  'Mid-to-late stage B2B SaaS companies selling developer or productivity tools ' +
  'to engineering and product teams. Bonus for companies that expose a public API.';

interface ScoredRow {
  '#'?: number;
  company?: string;
  industry?: string;
  notes?: string;
  score?: number | null;
  status?: string;
  reasoning?: string;
  enriched_fields?: {
    industry?: string;
    employee_range?: string;
    country?: string;
    signal?: string;
  };
  error?: string;
  [key: string]: unknown;
}

interface LeadScorerOutputs {
  total?: number;
  scored?: number;
  failed?: number;
  dry_run?: boolean;
  model?: string;
  rows?: ScoredRow[];
  score_distribution?: Record<string, number>;
}

function asLeadScorerOutputs(record: RunRecord): LeadScorerOutputs | null {
  const o = record.outputs;
  if (!o || typeof o !== 'object') return null;
  return o as LeadScorerOutputs;
}

async function pollUntilDone(
  runId: string,
  onUpdate: (r: RunRecord) => void,
  maxMs = 90000,
): Promise<RunRecord> {
  const start = Date.now();
  let delay = 500;
  // lead-scorer with Gemini + web-search grounding usually lands in
  // 15-45s for 5 rows (parallel calls, per-call timeout is 45s). We cap
  // the landing poll at 90s; if something goes sideways the user still
  // sees a clean error instead of a silently-stuck UI.
  while (Date.now() - start < maxMs) {
    const rec = await getRun(runId);
    onUpdate(rec);
    if (rec.status !== 'running' && rec.status !== 'pending') {
      return rec;
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.4, 2000);
  }
  throw new Error('Timed out waiting for the demo run');
}

export function InlineDemo() {
  const [state, setState] = useState<DemoState>(INITIAL);
  const [byokOpen, setByokOpen] = useState(false);
  const [byokPayload, setByokPayload] = useState<{
    slug?: string;
    usage?: number;
    limit?: number;
    get_key_url?: string;
    message?: string;
  } | null>(null);

  const run = useCallback(async () => {
    setState({ ...INITIAL, status: 'running' });
    try {
      const { run_id } = await startRun('lead-scorer', {
        data: SAMPLE_CSV,
        icp: SAMPLE_ICP,
      });
      setState((s) => ({ ...s, runId: run_id }));
      const final = await pollUntilDone(run_id, (rec) => {
        setState((s) => ({
          ...s,
          runId: rec.id,
          output: rec.outputs ?? null,
          durationMs: rec.duration_ms,
        }));
      });
      if (final.status === 'success') {
        setState({
          status: 'done',
          runId: final.id,
          output: final.outputs ?? null,
          error: null,
          durationMs: final.duration_ms,
        });
      } else {
        setState({
          status: 'error',
          runId: final.id,
          output: final.outputs ?? null,
          error: final.error ?? `Run ${final.status}`,
          durationMs: final.duration_ms,
        });
      }
    } catch (e) {
      // BYOK gate (launch 2026-04-21): the server returns 429 with
      // { error: 'byok_required', ... } once the 5 free runs/IP/24h are
      // used. Show the modal; on save the user's key flows through
      // startRun's X-User-Api-Key header on the retry.
      if (
        e instanceof ApiError &&
        e.status === 429 &&
        e.payload &&
        typeof e.payload === 'object' &&
        (e.payload as { error?: string }).error === 'byok_required'
      ) {
        setByokPayload(e.payload as typeof byokPayload);
        setByokOpen(true);
        setState({ ...INITIAL, status: 'idle' });
        return;
      }
      setState({
        status: 'error',
        runId: null,
        output: null,
        error: e instanceof Error ? e.message : 'Unknown error',
        durationMs: null,
      });
    }
  }, []);

  const isRunning = state.status === 'running';
  const outputs = asLeadScorerOutputs({ outputs: state.output } as RunRecord);
  const rows = outputs?.rows ?? [];

  return (
    <section
      data-testid="home-inline-demo"
      data-section="inline-demo"
      style={{
        background: 'var(--bg)',
        padding: '72px 24px',
      }}
    >
      <div style={{ maxWidth: 820, margin: '0 auto' }}>
        <header style={{ textAlign: 'center', marginBottom: 32 }}>
          <SectionEyebrow tone="accent" testid="inline-demo-eyebrow">
            Try it live · right here, right now
          </SectionEyebrow>
          <h2
            style={{
              fontFamily: "'DM Serif Display', Georgia, serif",
              fontWeight: 400,
              fontSize: 40,
              lineHeight: 1.1,
              letterSpacing: '-0.02em',
              color: 'var(--ink)',
              margin: '0 0 12px',
            }}
          >
            Try it with a real app.
          </h2>
          <p
            style={{
              fontSize: 16,
              color: 'var(--muted)',
              lineHeight: 1.55,
              maxWidth: 560,
              margin: '0 auto',
            }}
          >
            Not a screenshot. Hit Run and you are scoring 5 real companies
            against an ICP through{' '}
            <Link
              to="/p/lead-scorer"
              style={{ color: 'var(--ink)', textDecoration: 'underline' }}
            >
              the lead-scorer app
            </Link>
            {' '}— same runtime every Floom app uses.
          </p>
        </header>

        <div
          style={{
            background: 'var(--card)',
            border: '1px solid var(--line)',
            borderRadius: 16,
            padding: 24,
            display: 'grid',
            gap: 18,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              borderBottom: '1px solid var(--line)',
              paddingBottom: 14,
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 38,
                height: 38,
                borderRadius: 10,
                background: '#ecfdf5',
                color: 'var(--accent)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                fontWeight: 700,
                fontSize: 13,
              }}
            >
              LS
            </span>
            <div>
              <div style={{ fontWeight: 700, color: 'var(--ink)', fontSize: 15 }}>
                Lead Scorer
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                POST /api/run · app_slug: <code>lead-scorer</code>
              </div>
            </div>
          </div>

          {/* Inputs preview. Plain read-only blocks so the visitor sees
              exactly what gets sent to /api/run — no surprise AI magic. */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
              gap: 12,
            }}
          >
            <div>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: '0.04em',
                  textTransform: 'uppercase',
                  color: 'var(--muted)',
                  marginBottom: 6,
                }}
              >
                CSV (5 leads)
              </div>
              <pre
                data-testid="inline-demo-csv"
                style={{
                  margin: 0,
                  padding: 12,
                  background: 'var(--bg)',
                  color: 'var(--ink)',
                  border: '1px solid var(--line)',
                  borderRadius: 8,
                  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                  fontSize: 11.5,
                  lineHeight: 1.5,
                  overflowX: 'auto',
                  whiteSpace: 'pre',
                  minHeight: 96,
                }}
              >
                {SAMPLE_CSV}
              </pre>
            </div>
            <div>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: '0.04em',
                  textTransform: 'uppercase',
                  color: 'var(--muted)',
                  marginBottom: 6,
                }}
              >
                ICP
              </div>
              <pre
                data-testid="inline-demo-icp"
                style={{
                  margin: 0,
                  padding: 12,
                  background: 'var(--bg)',
                  color: 'var(--ink)',
                  border: '1px solid var(--line)',
                  borderRadius: 8,
                  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                  fontSize: 11.5,
                  lineHeight: 1.55,
                  overflowX: 'auto',
                  whiteSpace: 'pre-wrap',
                  minHeight: 96,
                }}
              >
                {SAMPLE_ICP}
              </pre>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={run}
              disabled={isRunning}
              data-testid="inline-demo-run"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                background: 'var(--accent)',
                color: '#fff',
                border: '1px solid var(--accent)',
                borderRadius: 10,
                padding: '12px 20px',
                fontSize: 14,
                fontWeight: 600,
                cursor: isRunning ? 'wait' : 'pointer',
                opacity: isRunning ? 0.7 : 1,
                transition: 'opacity 140ms ease',
              }}
            >
              <Play size={14} aria-hidden="true" />
              {isRunning ? 'Scoring…' : 'Run'}
            </button>
            <span style={{ fontSize: 13, color: 'var(--muted)' }}>
              {state.status === 'idle' && '5 leads + ICP pre-filled. One click to score.'}
              {state.status === 'running' && 'Calling the runtime (Gemini + web search)…'}
              {state.status === 'done' &&
                `Done in ${state.durationMs ?? '—'}ms · run ${state.runId?.slice(0, 8)}`}
              {state.status === 'error' && `Failed: ${state.error}`}
            </span>
            <Link
              to="/p/lead-scorer"
              style={{
                marginLeft: 'auto',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 13,
                color: 'var(--muted)',
                textDecoration: 'none',
                fontWeight: 500,
              }}
            >
              Open full run page <ArrowRight size={13} aria-hidden="true" />
            </Link>
          </div>

          {/* Output: table of ranked rows if we have them, otherwise the
              placeholder / raw JSON fallback (for error paths, dry-run,
              or unexpected output shapes). */}
          {rows.length > 0 ? (
            <div
              data-testid="inline-demo-output"
              style={{
                border: '1px solid var(--line)',
                borderRadius: 10,
                overflow: 'hidden',
              }}
            >
              <table
                style={{
                  width: '100%',
                  borderCollapse: 'collapse',
                  fontSize: 13,
                  background: 'var(--bg)',
                  color: 'var(--ink)',
                }}
              >
                <thead>
                  <tr style={{ background: 'var(--card)' }}>
                    <th style={thStyle}>Company</th>
                    <th style={{ ...thStyle, textAlign: 'right', width: 76 }}>Score</th>
                    <th style={thStyle}>Why</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr
                      key={(r['#'] as number) ?? i}
                      style={{
                        borderTop: '1px solid var(--line)',
                      }}
                    >
                      <td style={tdStyle}>
                        <div style={{ fontWeight: 600 }}>
                          {String(r.company ?? r['#'] ?? `Row ${i + 1}`)}
                        </div>
                        {r.industry && (
                          <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                            {String(r.industry)}
                          </div>
                        )}
                      </td>
                      <td
                        style={{
                          ...tdStyle,
                          textAlign: 'right',
                          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                          fontWeight: 700,
                          color:
                            typeof r.score === 'number' && r.score >= 60
                              ? 'var(--accent)'
                              : 'var(--ink)',
                        }}
                      >
                        {typeof r.score === 'number' ? r.score : '—'}
                      </td>
                      <td style={{ ...tdStyle, color: 'var(--muted)', fontSize: 12.5 }}>
                        {r.reasoning
                          ? truncate(String(r.reasoning), 140)
                          : r.status === 'error'
                            ? `error: ${truncate(String(r.error ?? 'unknown'), 80)}`
                            : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {outputs?.dry_run && (
                <div
                  style={{
                    padding: '8px 12px',
                    fontSize: 11.5,
                    color: 'var(--muted)',
                    background: 'var(--card)',
                    borderTop: '1px solid var(--line)',
                  }}
                >
                  Dry run (no GEMINI_API_KEY server-side). Scores are placeholder values.
                </div>
              )}
            </div>
          ) : (
            <pre
              data-testid="inline-demo-output"
              style={{
                margin: 0,
                padding: '16px 18px',
                background: 'var(--bg)',
                color: 'var(--ink)',
                border: '1px solid var(--line)',
                fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                fontSize: 13,
                lineHeight: 1.65,
                borderRadius: 10,
                overflowX: 'auto',
                minHeight: 96,
                whiteSpace: 'pre',
              }}
            >
              {state.output === null ? (
                <span style={{ color: 'var(--muted)' }}>
                  {'// Scored leads appear here after Run.'}
                </span>
              ) : (
                JSON.stringify(state.output, null, 2)
              )}
            </pre>
          )}
        </div>
      </div>
      <BYOKModal
        open={byokOpen}
        payload={byokPayload}
        onClose={() => setByokOpen(false)}
        onSaved={() => {
          setByokOpen(false);
          // Retry the original run; startRun will now pick up the saved key.
          void run();
        }}
      />
    </section>
  );
}

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: 'var(--muted)',
  padding: '10px 14px',
};

const tdStyle: React.CSSProperties = {
  padding: '10px 14px',
  verticalAlign: 'top',
};

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}
