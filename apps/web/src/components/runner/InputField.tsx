// Shared input field, rendered from a single InputSpec. Used by RunSurface
// (v16 shell) and was the basis for the older AppInputsCard. Extracted so
// both call sites render identical controls with matching a11y labels.

import type { InputSpec } from '../../lib/types';

export const ARRAY_INPUT_NAMES = new Set<string>(['hashtags']);

/**
 * Fix 6 (2026-04-19): URL inputs auto-prepend `https://` when the user
 * types a bare domain (e.g. `github.com/owner/repo`). Skips prepending
 * when the value already carries a known scheme or is empty. Exported
 * for stress tests.
 */
export function maybePrependHttps(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return value;
  // Already has a scheme? Leave it alone. (Covers http:, https:, ftp:,
  // file:, mailto:, and anything else — URL schemes end in `:`.)
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return value;
  // Protocol-relative URL? Leave as-is; the browser will resolve it.
  if (trimmed.startsWith('//')) return value;
  // Looks like a bare domain or path (contains a `.` before the first `/`
  // or starts with a known TLD-shaped token). Prepend https://.
  const firstSlash = trimmed.indexOf('/');
  const host = firstSlash === -1 ? trimmed : trimmed.slice(0, firstSlash);
  if (host.includes('.') && !host.includes(' ')) {
    return `https://${trimmed}`;
  }
  return value;
}

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

  // Fix 6 (2026-04-19): URL inputs auto-prepend https:// on blur if the
  // user typed a bare domain. Placeholder swaps to a no-https example so
  // users aren't cued to type the scheme.
  if (spec.type === 'url') {
    const urlPlaceholder = spec.placeholder || 'github.com/owner/repo';
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
          type="url"
          placeholder={urlPlaceholder}
          value={str}
          onChange={(e) => onChange(e.target.value)}
          onBlur={(e) => {
            const next = maybePrependHttps(e.target.value);
            if (next !== e.target.value) onChange(next);
          }}
        />
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
        type="text"
        placeholder={spec.placeholder}
        value={str}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
