import type { ActionSpec, InputSpec, PickResult } from '../../lib/types';
import { AppIcon } from '../AppIcon';

interface Props {
  app: PickResult;
  actionSpec: ActionSpec;
  inputs: Record<string, unknown>;
  onChange: (name: string, value: unknown) => void;
  onRun: () => void;
  onReset: () => void;
  onOpenDetails?: () => void;
}

export function AppInputsCard({
  app,
  actionSpec,
  inputs,
  onChange,
  onRun,
  onReset,
  onOpenDetails,
}: Props) {
  return (
    <div className="assistant-turn">
      <p className="assistant-preamble">
        <strong>{app.name}</strong> is the best fit. Want me to run it?
      </p>
      {/* data-testid hook (2026-04-20): OutputPanel's error classifier
          focuses the first input inside this card when a
          user_input_error (4xx from upstream) comes back, so retrying
          means fixing the input, not clicking Run again. */}
      <div className="app-expanded-card" data-testid="app-inputs-card">
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
        <p className="parsed-hint">Auto-parsed from your prompt. Edit anything.</p>

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
            style={{ height: 40, padding: '0 24px', fontSize: 15 }}
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
  // Some app manifests literally include " (optional)" in the label; strip it so the
  // UI doesn't render "Field (optional) (optional)".
  const cleanLabel = (spec.label ?? '').replace(/\s*\(optional\)\s*$/i, '');

  if (spec.type === 'textarea') {
    return (
      <div className="input-group">
        <label className="input-label" htmlFor={`inp-${spec.name}`}>
          {cleanLabel}
          {!spec.required && (
            <span style={{ fontWeight: 400, color: 'var(--muted)' }}> (optional)</span>
          )}
        </label>
        <textarea
          id={`inp-${spec.name}`}
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
        <label className="input-label" htmlFor={`inp-${spec.name}`}>
          {cleanLabel}
        </label>
        <select
          id={`inp-${spec.name}`}
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
        <label className="input-label" htmlFor={`inp-${spec.name}`}>
          {cleanLabel}
          {!spec.required && (
            <span style={{ fontWeight: 400, color: 'var(--muted)' }}> (optional)</span>
          )}
        </label>
        <input
          id={`inp-${spec.name}`}
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
          id={`inp-${spec.name}`}
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
        />
        <label className="input-label" htmlFor={`inp-${spec.name}`} style={{ margin: 0 }}>
          {cleanLabel}
        </label>
      </div>
    );
  }

  return (
    <div className="input-group">
      <label className="input-label" htmlFor={`inp-${spec.name}`}>
        {cleanLabel}
        {!spec.required && (
          <span style={{ fontWeight: 400, color: 'var(--muted)' }}> (optional)</span>
        )}
      </label>
      <input
        id={`inp-${spec.name}`}
        className="input-field"
        type={spec.type === 'url' ? 'url' : 'text'}
        placeholder={spec.placeholder}
        value={str}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
