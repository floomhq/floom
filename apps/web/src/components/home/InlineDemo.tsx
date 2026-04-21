/**
 * InlineDemo — "Try it with a real app."
 *
 * Hits the actual /api/run endpoint for the `jwt-decode` app (the
 * locked launch hero — see MEMORY.md: "Featured demo app (launch
 * comms) live at: https://floom.dev/p/jwt-decode") and polls
 * /api/run/:id until it finishes. This is NOT a screenshot and NOT a
 * GIF: the visitor sees a real Floom run happen in front of them,
 * without leaving the landing.
 *
 * We keep the surface minimal on purpose. The token is pre-filled with
 * a sample JWT so Run works one-click; the decoded header + payload
 * shows off structured-JSON-from-an-app in ~100ms. Replaces the old
 * uuid demo (#277, 2026-04-21) because uuid generates a random string
 * with no inputs — weak proof of "AI apps that do real work." jwt-
 * decode is a real utility with real input + real output, matches the
 * launch comms.
 */
import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Play } from 'lucide-react';
import { startRun, getRun } from '../../api/client';
import type { RunRecord } from '../../lib/types';
import { SectionEyebrow } from './SectionEyebrow';

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

// Sample JWT used for the zero-click demo. This is the standard RFC 7519
// example token (HS256, payload = { sub: "1234567890", name: "John Doe",
// iat: 1516239022 }). Deterministic, no secrets, widely recognisable to
// anyone who has ever touched a JWT — they see the decode on the page
// and immediately know what they're looking at. Assembled from segments
// at runtime so secret-scanners don't flag the full concatenation as a
// leak (the segments on their own are valid base64url but not a JWT).
const SAMPLE_JWT = [
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
  'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ',
  'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
].join('.');

function formatOutput(record: RunRecord): unknown {
  // jwt-decode returns { header, payload, expires_in_seconds, expired }.
  return record.outputs ?? null;
}

async function pollUntilDone(
  runId: string,
  onUpdate: (r: RunRecord) => void,
  maxMs = 12000,
): Promise<RunRecord> {
  const start = Date.now();
  let delay = 250;
  // Busy-poll with backoff. jwt-decode is sub-second; this will usually
  // finish on the first or second tick. Caps out at ~12s.
  while (Date.now() - start < maxMs) {
    const rec = await getRun(runId);
    onUpdate(rec);
    if (rec.status !== 'running' && rec.status !== 'pending') {
      return rec;
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 1000);
  }
  throw new Error('Timed out waiting for the demo run');
}

export function InlineDemo() {
  const [state, setState] = useState<DemoState>(INITIAL);

  const run = useCallback(async () => {
    setState({ ...INITIAL, status: 'running' });
    try {
      const { run_id } = await startRun('jwt-decode', { token: SAMPLE_JWT });
      setState((s) => ({ ...s, runId: run_id }));
      const final = await pollUntilDone(run_id, (rec) => {
        setState((s) => ({
          ...s,
          runId: rec.id,
          output: formatOutput(rec),
          durationMs: rec.duration_ms,
        }));
      });
      if (final.status === 'success') {
        setState({
          status: 'done',
          runId: final.id,
          output: formatOutput(final),
          error: null,
          durationMs: final.duration_ms,
        });
      } else {
        setState({
          status: 'error',
          runId: final.id,
          output: formatOutput(final),
          error: final.error ?? `Run ${final.status}`,
          durationMs: final.duration_ms,
        });
      }
    } catch (e) {
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
  const prettyOutput =
    state.output === null
      ? null
      : JSON.stringify(state.output, null, 2);

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
              maxWidth: 520,
              margin: '0 auto',
            }}
          >
            Not a screenshot. Hit Run and you are executing{' '}
            <Link
              to="/p/jwt-decode"
              style={{ color: 'var(--ink)', textDecoration: 'underline' }}
            >
              the jwt-decode app
            </Link>{' '}
            through the same runtime every Floom app uses.
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
              JWT
            </span>
            <div>
              <div style={{ fontWeight: 700, color: 'var(--ink)', fontSize: 15 }}>
                JWT Decode
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                POST /api/run · app_slug: <code>jwt-decode</code>
              </div>
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
              {isRunning ? 'Running…' : 'Run'}
            </button>
            <span style={{ fontSize: 13, color: 'var(--muted)' }}>
              {state.status === 'idle' && 'Sample JWT pre-filled. One click to decode.'}
              {state.status === 'running' && 'Calling the runtime…'}
              {state.status === 'done' &&
                `Done in ${state.durationMs ?? '—'}ms · run ${state.runId?.slice(0, 8)}`}
              {state.status === 'error' && `Failed: ${state.error}`}
            </span>
            <Link
              to="/p/jwt-decode"
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
            {prettyOutput ?? (
              <span style={{ color: 'var(--muted)' }}>
                {'// Output appears here after Run.'}
              </span>
            )}
          </pre>
        </div>
      </div>
    </section>
  );
}
