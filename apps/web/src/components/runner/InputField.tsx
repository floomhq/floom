// Shared input field, rendered from a single InputSpec. Used by RunSurface
// (v16 shell) and was the basis for the older AppInputsCard. Extracted so
// both call sites render identical controls with matching a11y labels.

import type { InputSpec } from '../../lib/types';

export const ARRAY_INPUT_NAMES = new Set<string>(['hashtags']);

interface Props {
  spec: InputSpec;
  value: unknown;
  onChange: (v: unknown) => void;
  /** Prefix for the generated `id` so multiple forms on one page don't collide. */
  idPrefix?: string;
}

export function InputField({ spec, value, onChange, idPrefix = 'floom-inp' }: Props) {
  const str = typeof value === 'string' ? value : value == null ? '' : String(value);
  // Some app manifests literally include " (optional)" in the label; strip it so
  // the UI doesn't render "Field (optional) (optional)".
  const cleanLabel = (spec.label ?? '').replace(/\s*\(optional\)\s*$/i, '');
  const id = `${idPrefix}-${spec.name}`;

  if (spec.type === 'textarea') {
    const isArray = ARRAY_INPUT_NAMES.has(spec.name);
    return (
      <div className="input-group">
        <label className="input-label" htmlFor={id}>
          {cleanLabel}
          {!spec.required && (
            <span style={{ fontWeight: 400, color: 'var(--muted)' }}> (optional)</span>
          )}
        </label>
        <textarea
          id={id}
          className="input-field"
          style={{ height: 96, padding: '10px 12px', resize: 'vertical' as const }}
          placeholder={spec.placeholder || (isArray ? 'vienna, berlin, paris' : undefined)}
          value={str}
          onChange={(e) => onChange(e.target.value)}
        />
        {isArray && (
          <p style={{ fontSize: 11, color: 'var(--muted)', margin: '4px 0 0' }}>
            Separate multiple values with a comma or a new line.
          </p>
        )}
      </div>
    );
  }

  if (spec.type === 'enum' && spec.options) {
    return (
      <div className="input-group">
        <label className="input-label" htmlFor={id}>
          {cleanLabel}
        </label>
        <select
          id={id}
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
        <label className="input-label" htmlFor={id}>
          {cleanLabel}
          {!spec.required && (
            <span style={{ fontWeight: 400, color: 'var(--muted)' }}> (optional)</span>
          )}
        </label>
        <input
          id={id}
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
      <div
        className="input-group"
        style={{ display: 'flex', alignItems: 'center', gap: 10 }}
      >
        <input
          id={id}
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
        />
        <label className="input-label" htmlFor={id} style={{ margin: 0 }}>
          {cleanLabel}
        </label>
      </div>
    );
  }

  return (
    <div className="input-group">
      <label className="input-label" htmlFor={id}>
        {cleanLabel}
        {!spec.required && (
          <span style={{ fontWeight: 400, color: 'var(--muted)' }}> (optional)</span>
        )}
      </label>
      <input
        id={id}
        className="input-field"
        type={spec.type === 'url' ? 'url' : 'text'}
        placeholder={spec.placeholder}
        value={str}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
