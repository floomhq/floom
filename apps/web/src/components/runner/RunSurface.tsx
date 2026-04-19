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
import { Link, useSearchParams } from 'react-router-dom';
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
import { ARRAY_INPUT_NAMES, InputField, maybePrependHttps } from './InputField';
import { useSession } from '../../hooks/useSession';
import * as api from '../../api/client';
import { buildPublicRunPath, getRunStartErrorMessage } from '../../lib/publicPermalinks';

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

/**
 * Upgrade 2 (2026-04-19): pick the entry action on mount. Honors an
 * optional `?action=<name>` URL param so multi-action apps can be linked
 * directly to a specific tab (e.g. /p/session-recall?action=report).
 * Falls back to the first action if the param is absent or unknown.
 */
function pickInitialAction(
  app: AppDetail,
  actionParam: string | null,
): { action: string; spec: ActionSpec } | null {
  if (actionParam && app.manifest.actions[actionParam]) {
    return { action: actionParam, spec: app.manifest.actions[actionParam] };
  }
  return getDefaultActionSpec(app);
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
    // Fix 6 (2026-04-19): last-chance https:// prepend for URL fields at
    // submit time (in case the user pressed Enter before the field blurred).
    if (inp.type === 'url') {
      const raw = out[inp.name];
      if (typeof raw === 'string' && raw.length > 0) {
        out[inp.name] = maybePrependHttps(raw);
      }
    }
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
  // Upgrade 2 (2026-04-19): honor ?action=<name> on mount so multi-action
  // apps can be linked directly to a specific tab. Only the initial
  // value is consumed below so later param changes don't stomp on the
  // user's active selection. Tab clicks update the URL via
  // setSearchParams to keep links shareable.
  const [, setSearchParams] = useSearchParams();
  const initialActionParam = useMemo(() => {
    if (typeof window === 'undefined') return null;
    try {
      return new URLSearchParams(window.location.search).get('action');
    } catch {
      return null;
    }
    // Intentionally empty deps: we only want the initial URL at mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const defaultEntry = getDefaultActionSpec(app);
  const actionEntries = useMemo(
    () => Object.entries(app.manifest.actions) as Array<[string, ActionSpec]>,
    [app.manifest.actions],
  );
  const hasMultipleActions = actionEntries.length > 1;

  const [state, setState] = useState<RunState>(() => {
    const initialPick = pickInitialAction(app, initialActionParam);
    if (!initialPick) {
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
          : initialPick.action;
      const spec = app.manifest.actions[actionName] ?? initialPick.spec;
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
      inputs: buildInitialInputs(initialPick.spec, initialInputs),
      action: initialPick.action,
      actionSpec: initialPick.spec,
      hasRun: false,
    };
  });

  const handleInputChange = useCallback((name: string, value: unknown) => {
    setState((s) => ({ ...s, inputs: { ...s.inputs, [name]: value } }));
  }, []);

  // Upgrade 2: swap to a different action tab. Clears any in-flight
  // run state so the new tab starts clean; preserves `hasRun` so the
  // Run → Refine flip (when refinable) persists across tab switches.
  const handleSelectAction = useCallback(
    (nextAction: string) => {
      const spec = app.manifest.actions[nextAction];
      if (!spec) return;
      setState((s) => ({
        ...s,
        phase: 'ready',
        action: nextAction,
        actionSpec: spec,
        inputs: buildInitialInputs(spec),
        runId: undefined,
        run: undefined,
        logs: undefined,
        job: undefined,
        jobId: undefined,
        errorMessage: undefined,
      }));
      onResetInitialRun?.();
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          // Keep the URL clean for the default action; any non-default
          // action stays explicit so it remains shareable.
          if (defaultEntry && nextAction === defaultEntry.action) {
            next.delete('action');
          } else {
            next.set('action', nextAction);
          }
          return next;
        },
        { replace: true },
      );
    },
    [app.manifest.actions, defaultEntry, onResetInitialRun, setSearchParams],
  );

  const handleReset = useCallback(() => {
    if (!defaultEntry) return;
    setState((s) => {
      // Upgrade 2 (2026-04-19): preserve the currently-selected action on
      // reset instead of snapping back to the first action. Users picking
      // a non-default tab and pressing Reset expect the same tab to stay.
      const currentSpec =
        (s.action && app.manifest.actions[s.action]) || defaultEntry.spec;
      const currentAction = s.action || defaultEntry.action;
      return {
        phase: 'ready',
        inputs: buildInitialInputs(currentSpec, initialInputs),
        action: currentAction,
        actionSpec: currentSpec,
        hasRun: s.hasRun,
      };
    });
    onResetInitialRun?.();
  }, [app.manifest.actions, defaultEntry, initialInputs, onResetInitialRun]);

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
          errorMessage: getRunStartErrorMessage(e, 'Could not enqueue job'),
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
        errorMessage: getRunStartErrorMessage(e, 'Run failed to start'),
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

  // Refine UI is opt-in as of 2026-04-19 (previously default-on). Creators
  // declare `render.refinable: true` in seed.json / manifest to flip the
  // primary button to "Refine" after the first run AND to expose the
  // bottom "Iterate" free-text composer on OutputPanel. Apps that are
  // deterministic one-shots (uuid, hash, password, …) correctly stay
  // stuck on "Run" and hide the iterate box. Fix 2 (2026-04-19).
  const refinable = app.manifest?.render?.refinable === true;
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
      data-has-refine={refinable ? 'true' : 'false'}
      data-has-iterate={refinable ? 'true' : 'false'}
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

      {/* Upgrade 2 (2026-04-19): action tab strip for multi-action apps.
          Hidden on single-action apps to preserve the current layout.
          Each tab swaps the input card + POST target action. */}
      {hasMultipleActions && (
        <div
          role="tablist"
          aria-label="App actions"
          data-testid="run-surface-action-tabs"
          style={{
            display: 'flex',
            gap: 2,
            borderBottom: '1px solid var(--line)',
            marginBottom: 16,
            overflowX: 'auto',
          }}
        >
          {actionEntries.map(([name, spec]) => {
            const isOn = state.action === name;
            return (
              <button
                key={name}
                type="button"
                role="tab"
                aria-selected={isOn}
                data-testid={`run-surface-action-tab-${name}`}
                data-state={isOn ? 'active' : 'inactive'}
                onClick={() => handleSelectAction(name)}
                style={{
                  padding: '10px 16px',
                  fontSize: 13,
                  fontWeight: 600,
                  border: 'none',
                  background: 'transparent',
                  color: isOn ? 'var(--accent)' : 'var(--muted)',
                  borderBottom: isOn ? '2px solid var(--accent)' : '2px solid transparent',
                  marginBottom: -1,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  whiteSpace: 'nowrap',
                }}
              >
                {spec.label || name}
              </button>
            );
          })}
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
            refinable={refinable}
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
            onRetry={handleRun}
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
  // Fix 5 (2026-04-19): progressive disclosure of optional inputs.
  // Required fields render inline, optional fields stay collapsed behind
  // a "Show N optional fields" toggle. Reduces form length on apps like
  // OpenSlides that have 1 required + 3 optional inputs.
  const [showOptional, setShowOptional] = useState(false);
  const { required, optional } = useMemo(() => {
    const req: typeof actionSpec.inputs = [];
    const opt: typeof actionSpec.inputs = [];
    for (const inp of actionSpec.inputs) {
      if (inp.required) req.push(inp);
      else opt.push(inp);
    }
    return { required: req, optional: opt };
  }, [actionSpec.inputs]);

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
          <div className="run-surface-fields" data-testid="run-surface-fields-required">
            {required.map((inp) => (
              <InputField
                key={inp.name}
                spec={inp}
                value={inputs[inp.name]}
                onChange={(v) => onChange(inp.name, v)}
                idPrefix="run-surface-inp"
              />
            ))}
          </div>
          {optional.length > 0 && (
            <>
              {!showOptional && (
                <button
                  type="button"
                  data-testid="run-surface-show-optional"
                  onClick={() => setShowOptional(true)}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    marginTop: 8,
                    padding: '6px 2px',
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--muted)',
                    fontSize: 13,
                    fontWeight: 500,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  Show {optional.length} optional field
                  {optional.length === 1 ? '' : 's'} &rarr;
                </button>
              )}
              {showOptional && (
                <div
                  className="run-surface-fields"
                  data-testid="run-surface-fields-optional"
                  style={{ marginTop: 8 }}
                >
                  {optional.map((inp) => (
                    <InputField
                      key={inp.name}
                      spec={inp}
                      value={inputs[inp.name]}
                      onChange={(v) => onChange(inp.name, v)}
                      idPrefix="run-surface-inp"
                    />
                  ))}
                </div>
              )}
            </>
          )}
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
  refinable: boolean;
  onCancelJob: () => void;
  onCancelStream: () => void;
  onIterate: (prompt: string) => void;
  /**
   * Error taxonomy (2026-04-20): called when the error card renders a
   * "Try again" button (upstream_outage class). Resubmits the same
   * inputs. RunSurface wires this to its top-level handleRun.
   */
  onRetry: () => void;
}

function OutputSlot({
  app,
  appAsPickResult,
  state,
  refinable,
  onCancelJob,
  onCancelStream,
  onIterate,
  onRetry,
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

  // Hide the bottom "Iterate" composer when refinable is not opted in.
  // OutputPanel renders the Iterate row iff onIterate is truthy, so
  // passing undefined cleanly hides both the label and the input.
  const iterateHandler = refinable ? onIterate : undefined;

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
          onIterate={iterateHandler}
          onRetry={onRetry}
        />
      </CustomRendererHost>
    );
  }

  return (
    <OutputPanel
      app={appAsPickResult}
      appDetail={app}
      run={state.run}
      onIterate={iterateHandler}
      onRetry={onRetry}
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
          // Fix 3 (2026-04-19): show up to 5 recent runs as cards with
          // status-dot · input-summary → output-summary · relative time.
          // Clicking navigates to /p/:slug?run=<id> which hydrates via
          // the shared-run path.
          <ul className="run-surface-past-list" data-testid="run-surface-past-list">
            {runs.slice(0, 5).map((r) => (
              <li key={r.id}>
                <Link
                  to={buildPublicRunPath(r.id)}
                  data-testid={`run-surface-past-row-${r.id}`}
                  className="run-surface-past-row"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    flexWrap: 'wrap',
                    padding: '10px 12px',
                    borderBottom: '1px solid var(--line)',
                    textDecoration: 'none',
                    color: 'var(--ink)',
                    minHeight: 44,
                  }}
                >
                  <span
                    aria-hidden="true"
                    data-status={r.status}
                    style={{
                      display: 'inline-block',
                      width: 8,
                      height: 8,
                      borderRadius: 999,
                      flexShrink: 0,
                      background: statusDotColor(r.status),
                    }}
                  />
                  <span
                    className="run-surface-past-input"
                    style={{
                      fontSize: 13,
                      color: 'var(--ink)',
                      maxWidth: 260,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {summarizeInputs(r.inputs)}
                  </span>
                  <span
                    aria-hidden="true"
                    style={{ color: 'var(--muted)', fontSize: 12 }}
                  >
                    &rarr;
                  </span>
                  <span
                    className="run-surface-past-output"
                    style={{
                      fontSize: 13,
                      color: 'var(--muted)',
                      flex: 1,
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {summarizeOutputs(r.outputs, r.status, r.error)}
                  </span>
                  <span
                    className="run-surface-past-when"
                    style={{
                      fontSize: 11,
                      color: 'var(--muted)',
                      marginLeft: 'auto',
                      flexShrink: 0,
                    }}
                  >
                    {formatWhen(r.started_at)}
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

/**
 * Map run status to a CSS color for the row's status dot. Green for
 * success, warning for timeout, red for errors, muted for anything else
 * (pending/running — which shouldn't appear in the history list but we
 * fall back gracefully).
 */
export function statusDotColor(status: string): string {
  if (status === 'success') return 'var(--accent, #10b981)';
  if (status === 'error') return 'var(--warning, #dc2626)';
  if (status === 'timeout') return 'var(--warning-soft, #f59e0b)';
  return 'var(--muted, #6b7280)';
}

/**
 * Produce a short human-readable snippet from a run's outputs for the
 * earlier-runs rail. Handles: error rows (shows the error string),
 * plain strings, and objects (picks the first non-empty primitive
 * field). Truncates at 40 chars.
 */
export function summarizeOutputs(
  outputs: unknown,
  status: string,
  error: string | null,
): string {
  if (status === 'error' || status === 'timeout') {
    const msg = (error || '').trim();
    return msg.length > 0
      ? msg.length > 40
        ? `${msg.slice(0, 37)}…`
        : msg
      : status;
  }
  if (outputs == null) return '';
  if (typeof outputs === 'string') {
    return outputs.length > 40 ? `${outputs.slice(0, 37)}…` : outputs;
  }
  if (typeof outputs === 'object') {
    const o = outputs as Record<string, unknown>;
    // Prefer common primary-field names first.
    const preferred = ['summary', 'uuid', 'result', 'output', 'text', 'message'];
    for (const key of preferred) {
      const v = o[key];
      if (typeof v === 'string' && v.trim()) {
        return v.length > 40 ? `${v.slice(0, 37)}…` : v;
      }
      if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'string') {
        const first = v[0] as string;
        return first.length > 40 ? `${first.slice(0, 37)}…` : first;
      }
    }
    // Fall back to the first non-empty primitive value.
    for (const v of Object.values(o)) {
      if (typeof v === 'string' && v.trim()) {
        return v.length > 40 ? `${v.slice(0, 37)}…` : v;
      }
      if (typeof v === 'number' || typeof v === 'boolean') {
        return String(v);
      }
    }
    const keys = Object.keys(o);
    if (keys.length > 0) return `{${keys.slice(0, 3).join(', ')}…}`;
  }
  return '';
}

function formatWhen(iso: string): string {
  try {
    const d = new Date(iso);
    const t = d.getTime();
    if (Number.isNaN(t)) return '';
    // Clamp negative diffs (future timestamps / clock skew) so fresh runs
    // never render `-Ns ago`. See lib/time.ts.
    const diff = Math.max(0, Date.now() - t);
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
  // Refine is opt-in: only flips on when the creator explicitly sets
  // `render.refinable: true` in the manifest. Default (undefined or false)
  // keeps the primary button on "Run" forever — desirable for one-shot
  // apps like uuid/hash where there's nothing to refine.
  const refinable = args.refinable === true;
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
  summarizeOutputs,
  statusDotColor,
  formatWhen,
};
