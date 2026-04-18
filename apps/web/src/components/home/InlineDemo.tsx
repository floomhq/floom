/**
 * InlineDemo — "Try it with a real app."
 *
 * Hits the actual /api/run endpoint for the zero-config `uuid` app and
 * polls /api/run/:id until it finishes. This is NOT a screenshot and NOT
 * a GIF: the visitor sees a real Floom run happen in front of them,
 * without leaving the landing.
 *
 * We keep the surface minimal on purpose. No field inputs (uuid takes
 * none), one Run button, a clear status indicator, and the raw JSON
 * output rendered in a monospace panel. For the full experience we link
 * out to /p/uuid.
 */
import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Play } from 'lucide-react';
import { startRun, getRun } from '../../api/client';
import type { RunRecord } from '../../lib/types';

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

function formatOutput(record: RunRecord): unknown {
  // uuid typically returns { uuid: "..." } or a list. Just show the shape.
  return record.outputs ?? null;
}

async function pollUntilDone(
  runId: string,
  onUpdate: (r: RunRecord) => void,
  maxMs = 12000,
): Promise<RunRecord> {
  const start = Date.now();
  let delay = 250;
  // Busy-poll with backoff. uuid is sub-second; this will usually
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
      const { run_id } = await startRun('uuid', {});
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
        padding: '96px 24px',
      }}
    >
      <div style={{ maxWidth: 820, margin: '0 auto' }}>
        <header style={{ textAlign: 'center', marginBottom: 40 }}>
          <h2
            style={{
              fontFamily: "'DM Serif Display', Georgia, serif",
              fontWeight: 400,
              fontSize: 44,
              lineHeight: 1.1,
              letterSpacing: '-0.02em',
              color: 'var(--ink)',
              margin: '0 0 14px',
            }}
          >
            Try it with a real app.
          </h2>
          <p
            style={{
              fontSize: 17,
              color: 'var(--muted)',
              lineHeight: 1.55,
              maxWidth: 520,
              margin: '0 auto',
            }}
          >
            This isn&apos;t a screenshot. Hit Run and you&apos;re executing{' '}
            <Link
              to="/p/uuid"
              style={{ color: 'var(--ink)', textDecoration: 'underline' }}
            >
              the uuid app
            </Link>{' '}
            through the same runtime every other Floom app uses.
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
              ID
            </span>
            <div>
              <div style={{ fontWeight: 700, color: 'var(--ink)', fontSize: 15 }}>
                UUID Generator
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                POST /api/run · app_slug: <code>uuid</code>
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
              {state.status === 'idle' && 'No inputs. Zero-config demo.'}
              {state.status === 'running' && 'Calling the runtime…'}
              {state.status === 'done' &&
                `Done in ${state.durationMs ?? '—'}ms · run ${state.runId?.slice(0, 8)}`}
              {state.status === 'error' && `Failed: ${state.error}`}
            </span>
            <Link
              to="/p/uuid"
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
              background: '#0b1220',
              color: '#e2e8f0',
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
              <span style={{ color: '#8b9ba9' }}>
                {'// Output appears here after Run.'}
              </span>
            )}
          </pre>
        </div>
      </div>
    </section>
  );
}
