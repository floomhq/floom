import { useState, useCallback } from 'react';
import type { AppDetail, ActionSpec, InputSpec, PickResult, RunRecord } from '../lib/types';
import { AppIcon } from './AppIcon';
import { StreamingTerminal } from './runner/StreamingTerminal';
import { OutputPanel } from './runner/OutputPanel';
import { Sidebar } from './Sidebar';
import * as api from '../api/client';

export interface FloomAppResult {
  runId: string;
  output: string;
  exitCode: number;
}

export interface FloomAppProps {
  app: AppDetail;
  initialInputs?: Record<string, unknown>;
  onResult?: (result: FloomAppResult) => void;
  showSidebar?: boolean;
  standalone?: boolean;
  theme?: 'light' | 'dark';
}

type Phase = 'inputs' | 'streaming' | 'done' | 'error';

interface RunState {
  phase: Phase;
  inputs: Record<string, unknown>;
  action: string;
  actionSpec: ActionSpec;
  // streaming
  runId?: string;
  logs?: string[];
  // done
  run?: RunRecord;
  // error
  errorMessage?: string;
}

function getDefaultActionSpec(app: AppDetail): { action: string; spec: ActionSpec } | null {
  const entries = Object.entries(app.manifest.actions);
  if (entries.length === 0) return null;
  const [action, spec] = entries[0];
  return { action, spec };
}

function buildInitialInputs(spec: ActionSpec, overrides?: Record<string, unknown>): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  for (const inp of spec.inputs) {
    inputs[inp.name] = overrides?.[inp.name] ?? inp.default ?? '';
  }
  return inputs;
}

export function FloomApp({
  app,
  initialInputs,
  onResult,
  showSidebar = true,
  standalone = false,
  theme = 'light',
}: FloomAppProps) {
  const defaultEntry = getDefaultActionSpec(app);
  const [state, setState] = useState<RunState>(() => {
    if (!defaultEntry) {
      return {
        phase: 'error' as Phase,
        inputs: {},
        action: '',
        actionSpec: { label: '', inputs: [], outputs: [] },
        errorMessage: 'No actions defined for this app.',
      };
    }
    return {
      phase: 'inputs' as Phase,
      inputs: buildInitialInputs(defaultEntry.spec, initialInputs),
      action: defaultEntry.action,
      actionSpec: defaultEntry.spec,
    };
  });

  const [sidebarOpen, setSidebarOpen] = useState(false);

  const handleInputChange = useCallback((name: string, value: unknown) => {
    setState((s) => ({ ...s, inputs: { ...s.inputs, [name]: value } }));
  }, []);

  const handleReset = useCallback(() => {
    if (!defaultEntry) return;
    setState((s) => ({
      ...s,
      phase: 'inputs',
      inputs: buildInitialInputs(defaultEntry.spec, initialInputs),
    }));
  }, [defaultEntry, initialInputs]);

  const handleRun = useCallback(async () => {
    if (state.phase !== 'inputs') return;
    const { inputs, action } = state;

    try {
      const { run_id } = await api.startRun(app.slug, inputs, undefined, action);
      setState((s) => ({
        ...s,
        phase: 'streaming',
        runId: run_id,
        logs: [],
      }));

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
          }));
          close();
          if (onResult) {
            onResult({
              runId: run.id,
              output: run.outputs ? JSON.stringify(run.outputs) : '',
              exitCode: run.status === 'success' ? 0 : 1,
            });
          }
        },
        onError: () => {
          // rely on polling fallback
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
  }, [state, app.slug, onResult]);

  const handleCancel = useCallback(() => {
    setState((s) => ({
      ...s,
      phase: 'error',
      errorMessage: 'Run cancelled.',
    }));
  }, []);

  const handleIterate = useCallback((prompt: string) => {
    if (!defaultEntry) return;
    setState({
      phase: 'inputs',
      inputs: buildInitialInputs(defaultEntry.spec, { prompt }),
      action: defaultEntry.action,
      actionSpec: defaultEntry.spec,
    });
  }, [defaultEntry]);

  const appAsPickResult: PickResult = {
    slug: app.slug,
    name: app.name,
    description: app.description,
    category: app.category,
    icon: app.icon,
    confidence: 1,
  };

  const wrapperClass = standalone
    ? `floom-app-standalone${theme === 'dark' ? ' floom-app-dark' : ''}`
    : `floom-app-embedded${theme === 'dark' ? ' floom-app-dark' : ''}`;

  return (
    <div className={wrapperClass} data-testid="floom-app">
      {state.phase === 'inputs' && (
        <InputsView
          app={appAsPickResult}
          actionSpec={state.actionSpec}
          inputs={state.inputs}
          standalone={standalone}
          onChange={handleInputChange}
          onRun={handleRun}
          onReset={handleReset}
          onOpenDetails={showSidebar ? () => setSidebarOpen(true) : undefined}
        />
      )}

      {state.phase === 'streaming' && (
        <StreamingTerminal
          app={appAsPickResult}
          lines={state.logs ?? []}
          onCancel={handleCancel}
        />
      )}

      {state.phase === 'done' && state.run && (
        <OutputPanel
          app={appAsPickResult}
          run={state.run}
          onIterate={handleIterate}
          onOpenDetails={showSidebar ? () => setSidebarOpen(true) : undefined}
        />
      )}

      {state.phase === 'error' && (
        <div className={standalone ? '' : 'assistant-turn'}>
          <div className="app-expanded-card" style={{ background: '#fdf4f1', borderColor: '#e7d0c9' }}>
            <p style={{ margin: 0, color: '#9a3a19', fontWeight: 600 }}>Something went wrong</p>
            <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--muted)' }}>
              {state.errorMessage || 'Try again.'}
            </p>
            <button
              type="button"
              onClick={handleReset}
              style={{
                marginTop: 12,
                padding: '6px 14px',
                background: 'var(--card)',
                border: '1px solid var(--line)',
                borderRadius: 8,
                fontSize: 13,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              Try again
            </button>
          </div>
        </div>
      )}

      {showSidebar && (
        <Sidebar
          app={sidebarOpen ? app : null}
          open={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
        />
      )}
    </div>
  );
}

// ── InputsView ─────────────────────────────────────────────────────────────

interface InputsViewProps {
  app: PickResult;
  actionSpec: ActionSpec;
  inputs: Record<string, unknown>;
  standalone: boolean;
  onChange: (name: string, value: unknown) => void;
  onRun: () => void;
  onReset: () => void;
  onOpenDetails?: () => void;
}

function InputsView({
  app,
  actionSpec,
  inputs,
  standalone,
  onChange,
  onRun,
  onReset,
  onOpenDetails,
}: InputsViewProps) {
  const cardStyle = standalone
    ? {
        maxWidth: 600,
        margin: '0 auto',
        padding: '32px',
      }
    : {};

  return (
    <div className={standalone ? '' : 'assistant-turn'}>
      {!standalone && (
        <p className="assistant-preamble">
          <strong>{app.name}</strong> is ready. Fill in the inputs and click Run.
        </p>
      )}
      <div className="app-expanded-card" style={cardStyle}>
        <div className="app-expanded-header">
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: 10,
              border: '1px solid var(--line)',
              background: 'var(--bg)',
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--ink)',
              cursor: onOpenDetails ? 'pointer' : 'default',
            }}
            onClick={onOpenDetails}
          >
            <AppIcon slug={app.slug} size={22} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--ink)' }}>{app.name}</span>
              <span className="category-pill">{app.category || 'app'}</span>
            </div>
            <p style={{ fontSize: 13, color: 'var(--muted)', margin: '4px 0 0' }}>
              {app.description}
            </p>
          </div>
        </div>
        <div className="divider" />

        {actionSpec.inputs.map((inp) => (
          <InputField
            key={inp.name}
            spec={inp}
            value={inputs[inp.name]}
            onChange={(v) => onChange(inp.name, v)}
          />
        ))}

        <div className="action-row">
          <button
            type="button"
            className="btn-primary"
            data-testid="floom-app-run-btn"
            style={{ height: 44, minHeight: 44, padding: '0 24px', fontSize: 15 }}
            onClick={onRun}
          >
            Run
            <svg
              viewBox="0 0 16 16"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              style={{ width: 14, height: 14 }}
              aria-hidden="true"
            >
              <path d="M5 3l6 5-6 5V3z" fill="currentColor" />
            </svg>
          </button>
          <button type="button" className="btn-ghost" onClick={onReset}>
            Reset
          </button>
        </div>
      </div>
    </div>
  );
}

// ── InputField (shared) ────────────────────────────────────────────────────

function InputField({
  spec,
  value,
  onChange,
}: {
  spec: InputSpec;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const str = typeof value === 'string' ? value : value == null ? '' : String(value);

  if (spec.type === 'textarea') {
    return (
      <div className="input-group">
        <label className="input-label" htmlFor={`floom-inp-${spec.name}`}>
          {spec.label}
          {!spec.required && (
            <span style={{ fontWeight: 400, color: 'var(--muted)' }}> (optional)</span>
          )}
        </label>
        <textarea
          id={`floom-inp-${spec.name}`}
          className="input-field"
          style={{ height: 80, padding: '10px 12px', resize: 'vertical' as const }}
          placeholder={spec.placeholder}
          value={str}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    );
  }

  if (spec.type === 'enum' && spec.options) {
    return (
      <div className="input-group">
        <label className="input-label" htmlFor={`floom-inp-${spec.name}`}>
          {spec.label}
        </label>
        <select
          id={`floom-inp-${spec.name}`}
          className="input-field"
          value={str}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">(pick one)</option>
          {spec.options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      </div>
    );
  }

  if (spec.type === 'number') {
    return (
      <div className="input-group">
        <label className="input-label" htmlFor={`floom-inp-${spec.name}`}>
          {spec.label}
          {!spec.required && (
            <span style={{ fontWeight: 400, color: 'var(--muted)' }}> (optional)</span>
          )}
        </label>
        <input
          id={`floom-inp-${spec.name}`}
          className="input-field"
          type="number"
          placeholder={spec.placeholder}
          value={str}
          onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
        />
      </div>
    );
  }

  if (spec.type === 'boolean') {
    return (
      <div className="input-group" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <input
          id={`floom-inp-${spec.name}`}
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
        />
        <label className="input-label" htmlFor={`floom-inp-${spec.name}`} style={{ margin: 0 }}>
          {spec.label}
        </label>
      </div>
    );
  }

  return (
    <div className="input-group">
      <label className="input-label" htmlFor={`floom-inp-${spec.name}`}>
        {spec.label}
        {!spec.required && (
          <span style={{ fontWeight: 400, color: 'var(--muted)' }}> (optional)</span>
        )}
      </label>
      <input
        id={`floom-inp-${spec.name}`}
        className="input-field"
        type={spec.type === 'url' ? 'url' : 'text'}
        placeholder={spec.placeholder}
        value={str}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
