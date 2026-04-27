// Shared input field, rendered from a single InputSpec. Used by RunSurface
// (v16 shell) and was the basis for the older AppInputsCard. Extracted so
// both call sites render identical controls with matching a11y labels.

import { useRef, useState } from 'react';
import type { InputSpec } from '../../lib/types';
import { credentialInputNameLooksSensitive } from '../../lib/credential-field';
import { DEFAULT_MAX_FILE_BYTES } from '../../api/client';
import { getLaunchDemoFilePrefills, loadSampleFile } from '../../lib/app-examples';
import { SecretInput } from '../forms/SecretInput';

export const ARRAY_INPUT_NAMES = new Set<string>(['hashtags', 'urls']);

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
  /**
   * Issue #256 (2026-04-21): per-field inline error. When set, the
   * control renders with a red ring + a small message below. The
   * control owns the aria-invalid + aria-describedby wiring so screen
   * readers announce the error together with the field label.
   */
  error?: string;
  /**
   * Launch-hardening 2026-04-23: current app slug, threaded from
   * RunSurface / AppInputsCard. Used only by the file-input control to
   * offer a one-click "Load example" button on the 3 hero demo apps
   * (lead-scorer, resume-screener). When undefined or when no example
   * is registered for the slug, the button is simply not rendered —
   * every other input type ignores it.
   */
  appSlug?: string;
}

function joinDescribedBy(...ids: Array<string | undefined>): string | undefined {
  const parts = ids.filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : undefined;
}

function InputLabel({
  id,
  label,
  required,
  description,
  descriptionId,
  inline = false,
}: {
  id: string;
  label: string;
  required?: boolean;
  description?: string;
  descriptionId?: string;
  inline?: boolean;
}) {
  const hasDescription = Boolean(description && description.trim().length > 0);
  return (
    <>
      <label className="input-label" htmlFor={id} style={inline ? { margin: 0 } : undefined}>
        <span>{label}</span>
        {hasDescription && (
          <button
            type="button"
            className="input-help-trigger"
            tabIndex={-1}
            aria-hidden="true"
            title={description}
            style={{
              marginLeft: 6,
              width: 16,
              height: 16,
              borderRadius: '50%',
              border: '1px solid var(--line)',
              background: 'var(--card)',
              color: 'var(--muted)',
              fontSize: 11,
              lineHeight: '14px',
              textAlign: 'center',
              cursor: 'help',
              padding: 0,
            }}
          >
            i
          </button>
        )}
        {!required && (
          <span style={{ fontWeight: 400, color: 'var(--muted)' }}> (optional)</span>
        )}
      </label>
      {hasDescription && (
        <p
          id={descriptionId}
          style={{
            margin: inline ? '4px 0 0' : '0 0 6px',
            fontSize: 11,
            color: 'var(--muted)',
            lineHeight: 1.4,
          }}
        >
          {description}
        </p>
      )}
    </>
  );
}

export function InputField({
  spec,
  value,
  onChange,
  idPrefix = 'floom-inp',
  error,
  appSlug,
}: Props) {
  const str = typeof value === 'string' ? value : value == null ? '' : String(value);
  // Some app manifests literally include " (optional)" in the label; strip it so
  // the UI doesn't render "Field (optional) (optional)".
  const cleanLabel = (spec.label ?? '').replace(/\s*\(optional\)\s*$/i, '');
  const id = `${idPrefix}-${spec.name}`;
  const errorId = error ? `${id}-error` : undefined;
  const descriptionId =
    typeof spec.description === 'string' && spec.description.trim()
      ? `${id}-desc`
      : undefined;
  const describedBy = joinDescribedBy(descriptionId, errorId);
  const invalid = Boolean(error);
  // Use inline style so we don't depend on a class that might not be
  // defined in every host context (InputField is used in multiple pages).
  const invalidStyle = invalid
    ? { borderColor: '#c44a2b', boxShadow: '0 0 0 3px rgba(196, 74, 43, 0.12)' }
    : undefined;

  if (spec.type === 'textarea') {
    const isArray = ARRAY_INPUT_NAMES.has(spec.name);
    // UX sweep 2026-04-24: textareas whose name is "urls" (competitor-
    // analyzer et al.) get the same auto-https treatment as single-URL
    // inputs. On blur, every non-empty line is normalized — users can
    // paste `linear.app` and we turn it into `https://linear.app`
    // before submit, mirroring the server-side normalization in
    // examples/competitor-analyzer/main.py::_normalize_urls.
    const isUrlArray = isArray && spec.name === 'urls';
    return (
      <div className="input-group">
        <InputLabel
          id={id}
          label={cleanLabel}
          required={spec.required}
          description={spec.description}
          descriptionId={descriptionId}
        />
        <textarea
          id={id}
          className="input-field"
          style={{ height: 96, padding: '10px 12px', resize: 'vertical' as const, ...invalidStyle }}
          placeholder={
            spec.placeholder ||
            (isUrlArray
              ? 'linear.app\nnotion.so (https:// optional)'
              : isArray
                ? 'vienna, berlin, paris'
                : undefined)
          }
          value={str}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.value)}
          onBlur={(e) => {
            if (!isUrlArray) return;
            const next = e.target.value
              .split('\n')
              .map((line) => maybePrependHttps(line))
              .join('\n');
            if (next !== e.target.value) onChange(next);
          }}
        />
        {error && <FieldError id={errorId!} text={error} />}
        {isArray && !error && (
          <p style={{ fontSize: 11, color: 'var(--muted)', margin: '4px 0 0' }}>
            {isUrlArray
              ? 'One URL per line. https:// added automatically.'
              : 'Separate multiple values with a comma or a new line.'}
          </p>
        )}
      </div>
    );
  }

  if (spec.type === 'enum' && spec.options) {
    return (
      <div className="input-group">
        <InputLabel
          id={id}
          label={cleanLabel}
          required={spec.required}
          description={spec.description}
          descriptionId={descriptionId}
        />
        <select
          id={id}
          className="input-field"
          style={invalidStyle}
          value={str}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">(pick one)</option>
          {spec.options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
        {error && <FieldError id={errorId!} text={error} />}
      </div>
    );
  }

  if (spec.type === 'number') {
    return (
      <div className="input-group">
        <InputLabel
          id={id}
          label={cleanLabel}
          required={spec.required}
          description={spec.description}
          descriptionId={descriptionId}
        />
        <input
          id={id}
          className="input-field"
          type="number"
          style={invalidStyle}
          placeholder={spec.placeholder}
          value={str}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
        />
        {error && <FieldError id={errorId!} text={error} />}
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
          aria-describedby={describedBy}
        />
        <InputLabel
          id={id}
          label={cleanLabel}
          required={spec.required}
          description={spec.description}
          descriptionId={descriptionId}
          inline
        />
      </div>
    );
  }

  // File input: drag-drop zone + click-to-pick. The File object passes
  // through on `onChange` and is walked by serializeInputs() before
  // JSON.stringify — both Docker and proxied runtimes consume the
  // resulting FileEnvelope. Spec.type is the narrow InputType 'file'
  // but manifest authors also use "file/csv", "file/pdf" etc. — we
  // accept any type that starts with "file".
  const isFileType = spec.type === 'file' || String(spec.type).startsWith('file');
  if (isFileType) {
    return (
      <FileInputControl
        spec={spec}
        value={value}
        onChange={onChange}
        id={id}
        label={cleanLabel}
        error={error}
        appSlug={appSlug}
        description={spec.description}
        descriptionId={descriptionId}
      />
    );
  }

  // Fix 6 (2026-04-19): URL inputs auto-prepend https:// on blur if the
  // user typed a bare domain. Placeholder swaps to a no-https example so
  // users aren't cued to type the scheme.
  if (spec.type === 'url') {
    const urlPlaceholder = spec.placeholder || 'linear.app (https:// optional)';
    return (
      <div className="input-group">
        <InputLabel
          id={id}
          label={cleanLabel}
          required={spec.required}
          description={spec.description}
          descriptionId={descriptionId}
        />
        <input
          id={id}
          className="input-field"
          type="url"
          style={invalidStyle}
          placeholder={urlPlaceholder}
          value={str}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.value)}
          onBlur={(e) => {
            const next = maybePrependHttps(e.target.value);
            if (next !== e.target.value) onChange(next);
          }}
        />
        {error && <FieldError id={errorId!} text={error} />}
      </div>
    );
  }

  const textControl = credentialInputNameLooksSensitive(spec.name) ? (
    <SecretInput
      id={id}
      className="input-field"
      style={invalidStyle}
      placeholder={spec.placeholder}
      value={str}
      name={spec.name}
      aria-invalid={invalid || undefined}
      aria-describedby={errorId}
      onChange={(e) => onChange(e.target.value)}
    />
  ) : (
    <input
      id={id}
      className="input-field"
      type="text"
      style={invalidStyle}
      placeholder={spec.placeholder}
      value={str}
      aria-invalid={invalid || undefined}
      aria-describedby={errorId}
      onChange={(e) => onChange(e.target.value)}
    />
  );

  return (
    <div className="input-group">
      <InputLabel
        id={id}
        label={cleanLabel}
        required={spec.required}
        description={spec.description}
        descriptionId={descriptionId}
      />
      {textControl}
      {error && <FieldError id={errorId!} text={error} />}
    </div>
  );
}

/**
 * File-input control. Drag-drop zone + click-to-pick. Accepts a single
 * `File` via onChange. Cap check (5 MB) mirrors the client serializer
 * so users see the size error before hitting Run, not after.
 *
 * Spec.type naming: the JSON schema says `type: "file"`, but some app
 * manifests write `file/csv` or `file/pdf` to advertise the expected
 * MIME. We pass the tail through to the `<input accept>` attribute so
 * the native picker pre-filters, but we never reject on client side —
 * the container is the authority on whether the bytes are usable.
 */
function FileInputControl({
  spec,
  value,
  onChange,
  id,
  label,
  error: externalError,
  appSlug,
  description,
  descriptionId,
}: {
  spec: InputSpec;
  value: unknown;
  onChange: (v: unknown) => void;
  id: string;
  label: string;
  error?: string;
  appSlug?: string;
  description?: string;
  descriptionId?: string;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [loadingSample, setLoadingSample] = useState(false);
  // Launch-hardening 2026-04-23: look up the bundled sample file (if
  // any) for this slug + input name. The registry lives in
  // lib/app-examples.ts and only covers the 3 hero launch demos, so
  // every other app hides the button automatically.
  const samplePrefill = appSlug
    ? getLaunchDemoFilePrefills(appSlug)?.[spec.name]
    : undefined;
  // Derive the accept attribute from a `file/<ext>` spec.type. "file/csv"
  // → ".csv,text/csv"; "file/pdf" → ".pdf,application/pdf"; "file"
  // (the narrow InputType) → unset (allow anything).
  const subtype = String(spec.type).includes('/')
    ? String(spec.type).split('/')[1]?.toLowerCase() ?? ''
    : '';
  const accept = subtype ? acceptFor(subtype) : undefined;
  const file = value instanceof File ? value : null;
  const err = externalError ?? localError ?? undefined;
  const errorId = err ? `${id}-error` : undefined;
  const describedBy = joinDescribedBy(descriptionId, errorId);

  const accept_file = (f: File | null) => {
    setLocalError(null);
    if (!f) {
      onChange(null);
      return;
    }
    if (f.size > DEFAULT_MAX_FILE_BYTES) {
      setLocalError(
        `File is ${formatBytes(f.size)} — cap is ${formatBytes(DEFAULT_MAX_FILE_BYTES)}. Try a smaller one.`,
      );
      onChange(null);
      return;
    }
    onChange(f);
  };

  return (
    <div className="input-group">
      <InputLabel
        id={id}
        label={label}
        required={spec.required}
        description={description}
        descriptionId={descriptionId}
      />
      <div
        data-testid={`file-drop-${spec.name}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const f = e.dataTransfer.files?.[0] ?? null;
          accept_file(f);
        }}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        role="button"
        tabIndex={0}
        aria-describedby={describedBy}
        style={{
          border: `1.5px dashed ${err ? '#c44a2b' : dragging ? 'var(--accent)' : 'var(--line)'}`,
          borderRadius: 10,
          padding: file ? '14px 16px' : '22px 16px',
          textAlign: 'center',
          background: dragging
            ? 'rgba(34, 139, 34, 0.04)'
            : file
              ? 'var(--card)'
              : 'rgba(0,0,0,0.015)',
          cursor: 'pointer',
          transition: 'border-color 120ms, background 120ms',
        }}
      >
        {file ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
              <FileIcon />
              <div style={{ textAlign: 'left', minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: 'var(--ink)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    maxWidth: 260,
                  }}
                >
                  {file.name}
                </div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                  {formatBytes(file.size)}
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                accept_file(null);
                if (inputRef.current) inputRef.current.value = '';
              }}
              style={{
                background: 'transparent',
                border: '1px solid var(--line)',
                borderRadius: 6,
                padding: '4px 10px',
                fontSize: 12,
                color: 'var(--muted)',
                cursor: 'pointer',
              }}
            >
              Remove
            </button>
          </div>
        ) : (
          <>
            <div style={{ fontSize: 13, color: 'var(--ink)', fontWeight: 500 }}>
              Drop a file here or click to pick
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
              {subtype ? `.${subtype} · ` : ''}
              up to {formatBytes(DEFAULT_MAX_FILE_BYTES)}
            </div>
            {samplePrefill && (
              <button
                type="button"
                data-testid={`file-load-sample-${spec.name}`}
                disabled={loadingSample}
                onClick={async (e) => {
                  // Stop propagation so the outer drop-zone click
                  // (which opens the native file picker) doesn't fire
                  // when the user clicks this mini action.
                  e.stopPropagation();
                  setLocalError(null);
                  setLoadingSample(true);
                  try {
                    const f = await loadSampleFile(appSlug!, spec.name);
                    accept_file(f);
                  } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    setLocalError(`Could not load sample file — ${msg}`);
                  } finally {
                    setLoadingSample(false);
                  }
                }}
                style={{
                  marginTop: 10,
                  /* Tap-target fix (2026-04-23, issue #562):
                     the desktop button was 22px tall (5px + 11px font +
                     5px), well under the WCAG 2.5.5 recommended 44px
                     minimum. Bump padding + min-height so touch users
                     can reliably hit it; desktop still reads as a
                     small pill thanks to the 11px font-size. */
                  padding: '10px 14px',
                  minHeight: 44,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 11,
                  fontWeight: 500,
                  color: 'var(--accent, #228b22)',
                  background: 'transparent',
                  border: '1px solid var(--accent, #228b22)',
                  borderRadius: 999,
                  cursor: loadingSample ? 'progress' : 'pointer',
                  opacity: loadingSample ? 0.6 : 1,
                  fontFamily: 'inherit',
                }}
              >
                {loadingSample ? 'Loading…' : samplePrefill.buttonLabel}
              </button>
            )}
          </>
        )}
        <input
          ref={inputRef}
          id={id}
          type="file"
          accept={accept}
          aria-invalid={Boolean(err) || undefined}
          aria-describedby={describedBy}
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            accept_file(f);
          }}
        />
      </div>
      {err && <FieldError id={errorId!} text={err} />}
    </div>
  );
}

function acceptFor(subtype: string): string {
  // Map common subtypes to `accept` values. Fall back to the subtype as
  // a bare extension (".xyz"), which works for anything the native
  // picker can filter on.
  switch (subtype) {
    case 'csv':
      return '.csv,text/csv';
    case 'pdf':
      return '.pdf,application/pdf';
    case 'image':
      return 'image/*';
    case 'audio':
      return 'audio/*';
    case 'video':
      return 'video/*';
    case 'zip':
      return '.zip,application/zip';
    case 'json':
      return '.json,application/json';
    case 'txt':
    case 'text':
      return '.txt,text/plain';
    default:
      return `.${subtype}`;
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function FileIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ color: 'var(--muted)', flexShrink: 0 }}
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

/**
 * Issue #256 (2026-04-21): inline field-level error copy. Kept lowercase
 * red without a harsh background wash so it matches the Floom card
 * system (ink on white, accent green for wins, red only for the actual
 * wrong bit). aria-live=polite so screen readers announce it once the
 * user tabs past the control.
 */
function FieldError({ id, text }: { id: string; text: string }) {
  return (
    <p
      id={id}
      role="alert"
      aria-live="polite"
      data-testid="input-field-error"
      style={{
        margin: '6px 0 0',
        fontSize: 12,
        lineHeight: 1.4,
        color: '#c44a2b',
      }}
    >
      {text}
    </p>
  );
}
