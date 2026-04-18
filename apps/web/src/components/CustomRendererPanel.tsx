// W2.2 custom renderer upload panel — creator UI for shipping a React
// renderer that replaces the default JSON dump in OutputPanel.
//
// Used in two places:
//   - /build after publish (Step 4, optional)
//   - /creator/:slug (edit renderer for an already published app)
//
// The backend compiles the pasted TSX via esbuild and serves the bundle at
// GET /renderer/:slug/bundle.js. The RunSurface lazy-loads the
// bundle on successful runs and mounts its default export. If compilation
// fails the default OutputPanel is used as a fallback so a broken renderer
// never blocks a run.

import { useEffect, useState } from 'react';
import type { RendererMeta } from '../lib/types';
import * as api from '../api/client';

interface Props {
  slug: string;
  initial?: RendererMeta | null;
  onChange?: (meta: RendererMeta | null) => void;
}

const STARTER_TEMPLATE = `// Floom custom renderer — receives the run output as props.
// Default export is mounted inside an ErrorBoundary; a crash here falls
// back to the default OutputPanel automatically.
//
// Imports are limited to React and @floom/renderer (externalized).

import React from 'react';
import type { RenderProps } from '@floom/renderer/contract';

export default function Renderer({ data }: RenderProps) {
  return (
    <div style={{
      padding: 16,
      border: '1px solid #e5e7eb',
      borderRadius: 12,
      background: '#fafafa',
      fontFamily: 'Inter, system-ui, sans-serif',
    }}>
      <h3 style={{ margin: 0, fontSize: 16 }}>Custom renderer</h3>
      <pre style={{
        marginTop: 8,
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 12,
        whiteSpace: 'pre-wrap',
      }}>{JSON.stringify(data, null, 2)}</pre>
    </div>
  );
}
`;

const OUTPUT_SHAPES = [
  'text',
  'markdown',
  'code',
  'table',
  'object',
  'image',
  'pdf',
  'audio',
] as const;

export function CustomRendererPanel({ slug, initial, onChange }: Props) {
  const [source, setSource] = useState<string>(STARTER_TEMPLATE);
  const [outputShape, setOutputShape] = useState<string>(initial?.output_shape || 'object');
  const [meta, setMeta] = useState<RendererMeta | null>(initial ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setMeta(initial ?? null);
    if (initial?.output_shape) setOutputShape(initial.output_shape);
  }, [initial]);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 512 * 1024) {
      setError('File exceeds 512 KB cap.');
      return;
    }
    const text = await file.text();
    setSource(text);
    setError(null);
  }

  async function handleUpload() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.uploadRenderer(slug, source, outputShape);
      const nextMeta: RendererMeta = {
        source_hash: result.source_hash,
        bytes: result.bytes,
        output_shape: result.output_shape,
        compiled_at: result.compiled_at,
      };
      setMeta(nextMeta);
      onChange?.(nextMeta);
    } catch (err) {
      setError((err as Error).message || 'Upload failed.');
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove() {
    if (!confirm('Remove the custom renderer and fall back to the default output panel?')) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteRenderer(slug);
      setMeta(null);
      onChange?.(null);
    } catch (err) {
      setError((err as Error).message || 'Delete failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="custom-renderer-panel">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: 10,
          flexWrap: 'wrap',
        }}
      >
        <div>
          <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>
            Custom renderer
          </p>
          <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--muted)' }}>
            Upload a React renderer so your app's output isn't a raw JSON dump. Compiled
            with esbuild on the server, capped at 256 KB. Imports are limited to React and
            <code style={{ fontFamily: 'JetBrains Mono, monospace' }}> @floom/renderer</code>.
          </p>
        </div>
        {meta ? (
          <span
            data-testid="renderer-status-pill"
            style={{
              padding: '4px 10px',
              borderRadius: 999,
              background: '#e6f4ea',
              color: '#1a7f37',
              fontSize: 11,
              fontWeight: 700,
            }}
          >
            Compiled · {formatBytes(meta.bytes)}
          </span>
        ) : (
          <span
            style={{
              padding: '4px 10px',
              borderRadius: 999,
              background: 'var(--bg)',
              color: 'var(--muted)',
              fontSize: 11,
              fontWeight: 700,
              border: '1px solid var(--line)',
            }}
          >
            Using default output panel
          </span>
        )}
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
        <label style={{ fontSize: 12, color: 'var(--muted)' }}>Output shape</label>
        <select
          value={outputShape}
          onChange={(e) => setOutputShape(e.target.value)}
          className="input-field"
          data-testid="renderer-shape"
          style={{ padding: '6px 10px', fontSize: 13, width: 'auto' }}
        >
          {OUTPUT_SHAPES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <label
          style={{
            fontSize: 12,
            color: 'var(--muted)',
            cursor: 'pointer',
            padding: '6px 12px',
            border: '1px dashed var(--line)',
            borderRadius: 8,
          }}
        >
          Upload .tsx file
          <input
            type="file"
            accept=".tsx,.ts,.jsx,.js,text/*"
            style={{ display: 'none' }}
            onChange={onFile}
            data-testid="renderer-file-input"
          />
        </label>
      </div>

      <textarea
        value={source}
        onChange={(e) => setSource(e.target.value)}
        data-testid="renderer-source"
        spellCheck={false}
        style={{
          width: '100%',
          minHeight: 240,
          padding: '12px 14px',
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 12,
          lineHeight: 1.5,
          border: '1px solid var(--line)',
          borderRadius: 8,
          background: 'var(--card)',
          color: 'var(--ink)',
          resize: 'vertical',
          boxSizing: 'border-box',
        }}
      />

      {error && (
        <p
          data-testid="renderer-error"
          style={{
            margin: '10px 0 0',
            padding: '10px 12px',
            background: '#fdecea',
            border: '1px solid #f4b7b1',
            color: '#c2321f',
            borderRadius: 8,
            fontSize: 13,
          }}
        >
          {error}
        </p>
      )}

      <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn-primary"
          onClick={handleUpload}
          disabled={busy || !source.trim()}
          data-testid="renderer-compile"
          style={{ padding: '10px 18px', fontSize: 13 }}
        >
          {busy ? 'Compiling…' : meta ? 'Recompile' : 'Compile and save'}
        </button>
        {meta && (
          <button
            type="button"
            className="btn-ghost"
            onClick={handleRemove}
            disabled={busy}
            data-testid="renderer-remove"
            style={{ padding: '10px 14px', fontSize: 13 }}
          >
            Remove renderer
          </button>
        )}
      </div>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
