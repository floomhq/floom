// RunSurface — v16 one-surface run shell. Replaces the FloomApp chat-turn
// wrapper (YOU: / APP: bubbles, "Message X…" composer, New thread button).
//
// Layout:
//   Desktop (>=1024px): 2-column grid (input 2fr, output 3fr)
//   Mobile  (<1024px):  stacked (input on top, output below)
//   Creator opt-out: manifest.render.render_hint === 'stacked' forces
//                    single column on desktop too.
//
// Behaviour contract (matches the task spec):
//   - Empty-input apps (e.g. uuid): input card shows a single Run button and
//     a short "this app takes no input" note. No placeholder "Message X…".
//   - Zero chat turns. The input card stays mounted across runs; the output
//     card swaps between empty state, JobProgress, streaming logs, the
//     cascade-picked renderer, and errors — all in the same slot.
//   - Refine loop: after a successful run, the primary button flips from
//     "Run" to "Refine" unless manifest.render.refinable === false.
//   - Past runs live in a collapsed <details> below the grid (auth-only).
//     Clicking a run navigates to /p/:slug?run=<id> which hydrates the run
//     via the PR #19 shared-run path.
//   - The renderer cascade (PR #66) is reused wholesale via OutputPanel,
//     including the Layer 1 CustomRendererHost iframe sandbox (PR #22).
//   - Async apps (is_async) route through JobProgress in the output slot.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type {
  ActionSpec,
  AppDetail,
  JobRecord,
  MeRunSummary,
  PickResult,
  RunRecord,
} from '../../lib/types';
import { AppIcon } from '../AppIcon';
import { OutputPanel } from './OutputPanel';
import { JobProgress } from './JobProgress';
import { CustomRendererHost } from './CustomRendererHost';
import { StreamingTerminal } from './StreamingTerminal';
import { ARRAY_INPUT_NAMES, InputField } from './InputField';
import { useSession } from '../../hooks/useSession';
import * as api from '../../api/client';

export interface RunSurfaceResult {
  runId: string;
  output: string;
  exitCode: number;
}

export interface RunSurfaceProps {
  app: AppDetail;
  initialInputs?: Record<string, unknown>;
  /**
   * Hydrate the surface in the `done` phase with an already-finished run.
   * Wired by /p/:slug?run=<id> so a shared link renders the run's output
   * without re-executing. The caller clears the ?run param via
   * onResetInitialRun when the visitor presses Refine / Run again.
   */
  initialRun?: RunRecord | null;
  onResetInitialRun?: () => void;
  onResult?: (result: RunSurfaceResult) => void;
}

type Phase = 'ready' | 'streaming' | 'job' | 'done' | 'error';

interface RunState {
  phase: Phase;
  inputs: Record<string, unknown>;
  action: string;
  actionSpec: ActionSpec;
  /** Keeps track of whether at least one run has succeeded (flips Run → Refine). */
  hasRun: boolean;
  runId?: string;
  logs?: string[];
  jobId?: string;
  job?: JobRecord | null;
  cancelPoll?: () => void;
  run?: RunRecord;
  errorMessage?: string;
}

function getDefaultActionSpec(app: AppDetail): { action: string; spec: ActionSpec } | null {
  const entries = Object.entries(app.manifest.actions);
  if (entries.length === 0) return null;
  const [action, spec] = entries[0];
  return { action, spec };
}

function buildInitialInputs(
  spec: ActionSpec,
  overrides?: Record<string, unknown>,
): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  for (const inp of spec.inputs) {
    inputs[inp.name] = overrides?.[inp.name] ?? inp.default ?? '';
  }
  return inputs;
}

function coerceInputs(
  inputs: Record<string, unknown>,
  spec: ActionSpec,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...inputs };
  for (const inp of spec.inputs) {
    if (!ARRAY_INPUT_NAMES.has(inp.name)) continue;
    const raw = out[inp.name];
    if (Array.isArray(raw)) continue;
    if (typeof raw === 'string') {
      out[inp.name] = raw
        .split(/[,\n]/)
        .map((p) => p.trim())
        .filter(Boolean);
    } else if (raw == null || raw === '') {
      out[inp.name] = [];
    }
  }
  return out;
}

function jobToRunRecord(job: JobRecord, action: string): RunRecord {
  const ok = job.status === 'succeeded';
  const startedAt = job.started_at || job.created_at;
  const finishedAt = job.finished_at;
  const duration =
    startedAt && finishedAt
      ? new Date(finishedAt).getTime() - new Date(startedAt).getTime()
      : null;
  const errorText =
    job.error == null
      ? null
      : typeof job.error === 'string'
        ? job.error
        : JSON.stringify(job.error);
  return {
    id: job.run_id || job.id,
    app_id: job.app_id,
    thread_id: null,
    action,
    inputs: job.input,
    outputs: job.output,
    status: ok ? 'success' : job.status === 'cancelled' ? 'error' : 'error',
    error: errorText,
    error_type: ok ? null : job.status === 'cancelled' ? 'cancelled' : 'runtime_error',
    duration_ms: duration,
    started_at: startedAt,
    finished_at: finishedAt,
    logs: '',
  };
}

export function RunSurface({
  app,
  initialInputs,
  initialRun,
  onResetInitialRun,
  onResult,
}: RunSurfaceProps) {
  const defaultEntry = getDefaultActionSpec(app);

  const [state, setState] = useState<RunState>(() => {
    if (!defaultEntry) {
      return {
        phase: 'error',
        inputs: {},
        action: '',
        actionSpec: { label: '', inputs: [], outputs: [] },
        hasRun: false,
        errorMessage: 'No actions defined for this app.',
      };
    }
    if (initialRun) {
      const actionName =
        initialRun.action in app.manifest.actions
          ? initialRun.action
          : defaultEntry.action;
      const spec = app.manifest.actions[actionName] ?? defaultEntry.spec;
      return {
        phase: 'done',
        inputs: (initialRun.inputs as Record<string, unknown>) ?? buildInitialInputs(spec),
        action: actionName,
        actionSpec: spec,
        hasRun: true,
        runId: initialRun.id,
        run: initialRun,
      };
    }
    return {
      phase: 'ready',
      inputs: buildInitialInputs(defaultEntry.spec, initialInputs),
      action: defaultEntry.action,
      actionSpec: defaultEntry.spec,
      hasRun: false,
    };
  });

  const handleInputChange = useCallback((name: string, value: unknown) => {
    setState((s) => ({ ...s, inputs: { ...s.inputs, [name]: value } }));
  }, []);

  const handleReset = useCallback(() => {
    if (!defaultEntry) return;
    setState((s) => ({
      phase: 'ready',
      inputs: buildInitialInputs(defaultEntry.spec, initialInputs),
      action: defaultEntry.action,
      actionSpec: defaultEntry.spec,
      hasRun: s.hasRun,
    }));
    onResetInitialRun?.();
  }, [defaultEntry, initialInputs, onResetInitialRun]);

  const handleRun = useCallback(async () => {
    if (state.phase !== 'ready' && state.phase !== 'done' && state.phase !== 'error') return;
    if (!defaultEntry) return;
    const action = state.action || defaultEntry.action;
    const actionSpec = state.actionSpec.inputs ? state.actionSpec : defaultEntry.spec;
    const inputs = coerceInputs(state.inputs, actionSpec);

    // Clear shared-run hydration on explicit re-run.
    onResetInitialRun?.();

    if (app.is_async) {
      try {
        const { job_id } = await api.startJob(app.slug, inputs, action);
        let stopPoll: (() => void) | null = null;
        setState((s) => ({
          ...s,
          phase: 'job',
          jobId: job_id,
          job: null,
        }));

        stopPoll = api.pollJob(app.slug, job_id, {
          onUpdate: (job) => {
            setState((s) => {
              if (s.phase !== 'job' || s.jobId !== job_id) return s;
              return { ...s, job };
            });
          },
          onDone: (job) => {
            const run = jobToRunRecord(job, action);
            setState((s) => ({
              ...s,
              phase: 'done',
              job,
              run,
              hasRun: true,
            }));
            if (typeof window !== 'undefined' && window.history?.replaceState) {
              try {
                const url = new URL(window.location.href);
                url.searchParams.set('job', job.id);
                window.history.replaceState(null, '', url.toString());
              } catch {
                /* ignore */
              }
            }
            onResult?.({
              runId: job.id,
              output: job.output ? JSON.stringify(job.output) : '',
              exitCode: job.status === 'succeeded' ? 0 : 1,
            });
          },
          onError: () => {
            /* transient; pollJob keeps ticking until stopped */
          },
        });

        setState((s) =>
          s.phase === 'job' && s.jobId === job_id
            ? { ...s, cancelPoll: stopPoll! }
            : s,
        );
      } catch (err) {
        const e = err as Error;
        setState((s) => ({
          ...s,
          phase: 'error',
          errorMessage: e.message || 'Could not enqueue job',
        }));
      }
      return;
    }

    try {
      const { run_id } = await api.startRun(app.slug, inputs, undefined, action);
      setState((s) => ({ ...s, phase: 'streaming', runId: run_id, logs: [] }));

      const close = api.streamRun(run_id, {
        onLog: (line) => {
          setState((s) => {
            if (s.phase !== 'streaming' || s.runId !== run_id) return s;
            return { ...s, logs: [...(s.logs ?? []), line.text] };
          });
        },
        onStatus: (run: RunRecord) => {
          if (!['success', 'error', 'timeout'].includes(run.status)) return;
          setState((s) => ({
            ...s,
            phase: 'done',
            run,
            hasRun: true,
          }));
          close();
          if (typeof window !== 'undefined' && window.history?.replaceState) {
            try {
              const url = new URL(window.location.href);
              url.searchParams.set('run', run.id);
              window.history.replaceState(null, '', url.toString());
            } catch {
              /* ignore */
            }
          }
          onResult?.({
            runId: run.id,
            output: run.outputs ? JSON.stringify(run.outputs) : '',
            exitCode: run.status === 'success' ? 0 : 1,
          });
        },
        onError: () => {
          /* polling fallback */
        },
      });
    } catch (err) {
      const e = err as Error;
      setState((s) => ({
        ...s,
        phase: 'error',
        errorMessage: e.message || 'Run failed to start',
      }));
    }
  }, [state, app.slug, app.is_async, defaultEntry, onResetInitialRun, onResult]);

  const handleCancelJob = useCallback(async () => {
    const s = state;
    if (s.phase !== 'job' || !s.jobId) return;
    try {
      s.cancelPoll?.();
      await api.cancelJob(app.slug, s.jobId);
    } catch {
      /* fall through to cancelled state */
    }
    setState((cur) => ({
      ...cur,
      phase: 'error',
      errorMessage: 'Job cancelled.',
    }));
  }, [state, app.slug]);

  const handleCancelStream = useCallback(() => {
    setState((s) => ({ ...s, phase: 'error', errorMessage: 'Run cancelled.' }));
  }, []);

  const appAsPickResult: PickResult = useMemo(
    () => ({
      slug: app.slug,
      name: app.name,
      description: app.description,
      category: app.category,
      icon: app.icon,
      confidence: 1,
    }),
    [app.slug, app.name, app.description, app.category, app.icon],
  );

  // Creator opt-out: manifest.render.render_hint === 'stacked' forces the
  // single-column layout regardless of viewport. Useful for apps whose
  // output is a wide preview (PDFs, dashboards) where the input card
  // would steal too much horizontal room.
  const renderHint = app.manifest?.render?.render_hint;
  const stacked = renderHint === 'stacked';

  const refinable = app.manifest?.render?.refinable !== false;
  const runLabel = state.hasRun && refinable ? 'Refine' : 'Run';

  const hasInputs = (state.actionSpec?.inputs?.length ?? 0) > 0;

  // Shared-run banner visibility — see deriveSharedRunBanner() below for
  // the pure decision logic + stress test hook.
  const viewingSharedRun = deriveSharedRunBanner({
    initialRunId: initialRun?.id ?? null,
    currentRunId: state.runId ?? null,
    phase: state.phase,
  });

  return (
    <div
      className={`run-surface${stacked ? ' run-surface-stacked' : ''}`}
      data-testid="run-surface"
      data-phase={state.phase}
    >
      {viewingSharedRun && (
        <div
          data-testid="shared-run-banner"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
            padding: '10px 14px',
            marginBottom: 16,
            background: 'var(--accent-soft, #ecfdf5)',
            border: '1px solid var(--accent-border, #86efac)',
            borderRadius: 10,
            fontSize: 13,
            color: 'var(--ink)',
          }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <span
              aria-hidden="true"
              style={{
                display: 'inline-block',
                width: 6,
                height: 6,
                borderRadius: 999,
                background: 'var(--accent, #10b981)',
              }}
            />
            Viewing a shared run.
          </span>
          <button
            type="button"
            data-testid="shared-run-try-yourself"
            onClick={handleReset}
            style={{
              padding: '6px 14px',
              borderRadius: 999,
              border: '1px solid var(--accent, #10b981)',
              background: 'var(--accent, #10b981)',
              color: '#fff',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Run this yourself &rarr;
          </button>
        </div>
      )}

      <div className="run-surface-grid">
        <section
          className="run-surface-input"
          data-testid="run-surface-input"
          aria-label="Input"
        >
          <InputCard
            app={appAsPickResult}
            actionSpec={state.actionSpec}
            inputs={state.inputs}
            runLabel={runLabel}
            running={state.phase === 'streaming' || state.phase === 'job'}
            onChange={handleInputChange}
            onRun={handleRun}
            onReset={handleReset}
            hasInputs={hasInputs}
          />
        </section>

        <section
          className="run-surface-output"
          data-testid="run-surface-output"
          aria-label="Output"
          aria-live="polite"
        >
          <OutputSlot
            app={app}
            appAsPickResult={appAsPickResult}
            state={state}
            onCancelJob={handleCancelJob}
            onCancelStream={handleCancelStream}
            onIterate={(prompt) => {
              setState((s) => ({
                ...s,
                phase: 'ready',
                inputs: { ...s.inputs, prompt },
              }));
              onResetInitialRun?.();
            }}
          />
        </section>
      </div>

      <PastRunsDisclosure appSlug={app.slug} />
    </div>
  );
}

// ── Input card ─────────────────────────────────────────────────────────────

interface InputCardProps {
  app: PickResult;
  actionSpec: ActionSpec;
  inputs: Record<string, unknown>;
  runLabel: string;
  running: boolean;
  hasInputs: boolean;
  onChange: (name: string, value: unknown) => void;
  onRun: () => void;
  onReset: () => void;
}

function InputCard({
  app,
  actionSpec,
  inputs,
  runLabel,
  running,
  hasInputs,
  onChange,
  onRun,
  onReset,
}: InputCardProps) {
  return (
    <div className="run-surface-card" data-testid="run-surface-input-card">
      <header className="run-surface-card-header">
        <div className="run-surface-icon" aria-hidden="true">
          <AppIcon slug={app.slug} size={22} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="run-surface-app-title">{app.name}</div>
          <div className="run-surface-app-sub">{app.category || 'app'}</div>
        </div>
      </header>

      {hasInputs ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!running) onRun();
          }}
        >
          <div className="run-surface-fields">
            {actionSpec.inputs.map((inp) => (
              <InputField
                key={inp.name}
                spec={inp}
                value={inputs[inp.name]}
                onChange={(v) => onChange(inp.name, v)}
                idPrefix="run-surface-inp"
              />
            ))}
          </div>
          <div className="run-surface-actions">
            <button
              type="submit"
              className="btn-primary"
              data-testid="run-surface-run-btn"
              disabled={running}
              style={{ height: 44, minHeight: 44, padding: '0 24px', fontSize: 15 }}
            >
              {runLabel}
              <RunArrow />
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={onReset}
              disabled={running}
            >
              Reset
            </button>
          </div>
        </form>
      ) : (
        <div className="run-surface-empty-input">
          <p className="run-surface-empty-copy">
            This app takes no input. Click {runLabel} to generate.
          </p>
          <div className="run-surface-actions">
            <button
              type="button"
              className="btn-primary"
              data-testid="run-surface-run-btn"
              onClick={onRun}
              disabled={running}
              style={{ height: 44, minHeight: 44, padding: '0 28px', fontSize: 15 }}
            >
              {runLabel}
              <RunArrow />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function RunArrow() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ width: 14, height: 14, marginLeft: 6 }}
      aria-hidden="true"
    >
      <path d="M5 3l6 5-6 5V3z" fill="currentColor" />
    </svg>
  );
}

// ── Output slot ────────────────────────────────────────────────────────────

interface OutputSlotProps {
  app: AppDetail;
  appAsPickResult: PickResult;
  state: RunState;
  onCancelJob: () => void;
  onCancelStream: () => void;
  onIterate: (prompt: string) => void;
}

function OutputSlot({
  app,
  appAsPickResult,
  state,
  onCancelJob,
  onCancelStream,
  onIterate,
}: OutputSlotProps) {
  if (state.phase === 'ready') {
    return <EmptyOutputCard appName={app.name} />;
  }

  if (state.phase === 'streaming') {
    return (
      <StreamingTerminal
        app={appAsPickResult}
        lines={state.logs ?? []}
        onCancel={onCancelStream}
      />
    );
  }

  if (state.phase === 'job') {
    return (
      <JobProgress
        app={appAsPickResult}
        job={state.job ?? null}
        onCancel={onCancelJob}
      />
    );
  }

  if (state.phase === 'error') {
    return (
      <div className="run-surface-card run-surface-error-card" data-testid="run-surface-error">
        <p className="run-surface-error-title">Something went wrong</p>
        <p className="run-surface-error-body">
          {state.errorMessage || 'Try again.'}
        </p>
      </div>
    );
  }

  // phase === 'done'
  if (!state.run) return null;

  if (app.renderer) {
    return (
      <CustomRendererHost
        slug={app.slug}
        run={state.run}
        sourceHash={app.renderer.source_hash}
      >
        <OutputPanel
          app={appAsPickResult}
          appDetail={app}
          run={state.run}
          onIterate={onIterate}
        />
      </CustomRendererHost>
    );
  }

  return (
    <OutputPanel
      app={appAsPickResult}
      appDetail={app}
      run={state.run}
      onIterate={onIterate}
    />
  );
}

function EmptyOutputCard({ appName }: { appName: string }) {
  return (
    <div
      className="run-surface-card run-surface-empty-output"
      data-testid="run-surface-empty-output"
    >
      <div className="run-surface-empty-output-inner">
        <div className="run-surface-empty-output-title">Output will appear here</div>
        <div className="run-surface-empty-output-sub">
          Fill in the form and press Run to generate a result with {appName}.
        </div>
      </div>
    </div>
  );
}

// ── Past runs disclosure ───────────────────────────────────────────────────

function PastRunsDisclosure({ appSlug }: { appSlug: string }) {
  const { isAuthenticated } = useSession();
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState<MeRunSummary[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !isAuthenticated || runs !== null) return;
    let cancelled = false;
    setLoading(true);
    api
      .getMyRuns(50)
      .then((res) => {
        if (cancelled) return;
        setRuns(res.runs.filter((r) => r.app_slug === appSlug));
      })
      .catch(() => {
        if (!cancelled) setRuns([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, isAuthenticated, runs, appSlug]);

  if (!isAuthenticated) return null;

  return (
    <details
      className="run-surface-past"
      data-testid="run-surface-past"
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className="run-surface-past-summary">Earlier runs</summary>
      <div className="run-surface-past-body">
        {loading && <div className="run-surface-past-hint">Loading…</div>}
        {!loading && runs !== null && runs.length === 0 && (
          <div className="run-surface-past-hint">
            No earlier runs for this app yet.
          </div>
        )}
        {!loading && runs !== null && runs.length > 0 && (
          <ul className="run-surface-past-list">
            {runs.slice(0, 20).map((r) => (
              <li key={r.id}>
                <Link
                  to={`/p/${appSlug}?run=${encodeURIComponent(r.id)}`}
                  data-testid={`run-surface-past-row-${r.id}`}
                  className="run-surface-past-row"
                >
                  <span className="run-surface-past-when">
                    {formatWhen(r.started_at)}
                  </span>
                  <span
                    className={`run-surface-past-status run-surface-past-status-${r.status}`}
                  >
                    {r.status}
                  </span>
                  <span className="run-surface-past-snippet">
                    {summarizeInputs(r.inputs)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}

function formatWhen(iso: string): string {
  try {
    const d = new Date(iso);
    const t = d.getTime();
    if (Number.isNaN(t)) return '';
    const diff = Date.now() - t;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return d.toLocaleDateString();
  } catch {
    return '';
  }
}

function summarizeInputs(inputs: Record<string, unknown> | null | undefined): string {
  if (!inputs) return '';
  const entries = Object.entries(inputs).filter(([, v]) => v != null && v !== '');
  if (entries.length === 0) return '(no input)';
  const [, firstValue] = entries[0];
  const s = typeof firstValue === 'string' ? firstValue : JSON.stringify(firstValue);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

// ── Pure helpers exposed for tests ─────────────────────────────────────────
//
// These are intentionally small and side-effect free so stress tests can
// exercise the run-button labelling, layout hint, and async→run adaptation
// without mounting the full React tree. The component itself uses the same
// implementations inline above.

export function deriveRunLabel(args: {
  hasRun: boolean;
  refinable: boolean | undefined;
}): 'Run' | 'Refine' {
  const refinable = args.refinable !== false;
  return args.hasRun && refinable ? 'Refine' : 'Run';
}

export function deriveStacked(renderHint: string | undefined): boolean {
  return renderHint === 'stacked';
}

/**
 * Banner visibility rule for /p/:slug?run=<id> deep-links. The banner
 * reads "Viewing a shared run." + offers a "Run this yourself" reset,
 * visible only while the surface is still showing the hydrated initial
 * run. The first re-run (or explicit reset) clears ?run= in the parent,
 * which drops initialRun back to null and takes the banner with it.
 */
export function deriveSharedRunBanner(args: {
  initialRunId: string | null | undefined;
  currentRunId: string | null | undefined;
  phase: 'ready' | 'streaming' | 'job' | 'done' | 'error';
}): boolean {
  if (!args.initialRunId) return false;
  if (args.currentRunId !== args.initialRunId) return false;
  return args.phase === 'done';
}

export const __test__ = {
  deriveRunLabel,
  deriveStacked,
  deriveSharedRunBanner,
  jobToRunRecord,
  coerceInputs,
  buildInitialInputs,
  getDefaultActionSpec,
  summarizeInputs,
  formatWhen,
};
