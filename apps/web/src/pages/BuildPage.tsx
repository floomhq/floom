// W4-minimal: /build — creator publish flow.
//
// Three steps:
//   1. Paste an OpenAPI URL (or GitHub repo — we just use the raw URL today).
//   2. Click "Detect" → show what Floom found (name, tools, auth, slug).
//      User can edit name, slug, description.
//   3. Click "Publish" → POST /api/hub/ingest → redirect to /p/:slug.
//
// Supports ?edit=<slug> pre-fill so the creator dashboard can re-use this
// page for edits (in which case the detect step is pre-ran against the
// existing app's spec URL).

import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { PageShell } from '../components/PageShell';
import * as api from '../api/client';
import type { DetectedApp } from '../lib/types';

type Step = 'paste' | 'review' | 'publishing' | 'done';

export function BuildPage() {
  const [searchParams] = useSearchParams();
  const editSlug = searchParams.get('edit');
  const navigate = useNavigate();
  const [url, setUrl] = useState('');
  const [detected, setDetected] = useState<DetectedApp | null>(null);
  const [step, setStep] = useState<Step>('paste');
  const [error, setError] = useState<string | null>(null);
  // editable overrides
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');

  // Pre-fill if we got here via /build?edit=slug
  useEffect(() => {
    if (!editSlug) return;
    api
      .getApp(editSlug)
      .then((existing) => {
        if (existing) {
          setName(existing.name);
          setSlug(existing.slug);
          setDescription(existing.description);
          setCategory(existing.category || '');
          // If there's an openapi spec url, try to re-detect from it
          // to repopulate the review screen.
          // Not persisted in the hub/:slug response today — user edits manually.
          setStep('paste');
        }
      })
      .catch(() => {
        // ignore — show the paste step
      });
  }, [editSlug]);

  async function handleDetect(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const result = await api.detectApp(url, name || undefined, slug || undefined);
      setDetected(result);
      setName(result.name);
      setSlug(result.slug);
      setDescription(result.description);
      setStep('review');
    } catch (err) {
      setError((err as Error).message || 'Could not fetch that spec.');
    }
  }

  async function handlePublish() {
    if (!detected) return;
    setStep('publishing');
    setError(null);
    try {
      const result = await api.ingestApp({
        openapi_url: detected.openapi_spec_url,
        name,
        slug,
        description,
        category: category || undefined,
      });
      setStep('done');
      setTimeout(() => navigate(`/p/${result.slug}`), 800);
    } catch (err) {
      setStep('review');
      setError((err as Error).message || 'Publish failed.');
    }
  }

  return (
    <PageShell requireAuth="cloud" title="Publish an app | Floom">
      <div data-testid="build-page" style={{ maxWidth: 680 }}>
        <div style={{ marginBottom: 32 }}>
          <Link
            to="/creator"
            style={{
              fontSize: 13,
              color: 'var(--muted)',
              textDecoration: 'none',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              marginBottom: 12,
            }}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path d="M8 2L4 6l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Creator dashboard
          </Link>
          <h1 style={{ fontSize: 28, fontWeight: 700, margin: '0 0 6px', color: 'var(--ink)' }}>
            {editSlug ? `Edit ${editSlug}` : 'Ship a new app'}
          </h1>
          <p style={{ fontSize: 14, color: 'var(--muted)', margin: 0 }}>
            Paste your OpenAPI URL. Floom detects the tools, generates a manifest, and ships a live
            MCP server + HTTP API + store page.
          </p>
        </div>

        {/* Step indicator */}
        <div
          style={{
            display: 'flex',
            gap: 8,
            marginBottom: 28,
            fontSize: 12,
            color: 'var(--muted)',
          }}
        >
          <StepBadge active={step === 'paste'} done={step !== 'paste'} label="1. Paste URL" />
          <StepBadge
            active={step === 'review'}
            done={step === 'publishing' || step === 'done'}
            label="2. Review"
          />
          <StepBadge active={step === 'publishing'} done={step === 'done'} label="3. Publish" />
        </div>

        {step === 'paste' && (
          <form onSubmit={handleDetect} data-testid="build-step-paste">
            <label
              style={{
                display: 'block',
                fontSize: 13,
                fontWeight: 600,
                color: 'var(--ink)',
                marginBottom: 8,
              }}
            >
              OpenAPI URL
            </label>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
              placeholder="https://api.example.com/openapi.json"
              data-testid="build-url-input"
              style={{
                width: '100%',
                padding: '12px 14px',
                border: '1px solid var(--line)',
                borderRadius: 10,
                background: 'var(--card)',
                fontSize: 14,
                color: 'var(--ink)',
                fontFamily: 'inherit',
                marginBottom: 12,
                boxSizing: 'border-box',
              }}
            />
            <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 20px' }}>
              We support OpenAPI 3.0 + 3.1 (JSON or YAML).
            </p>
            {error && (
              <p
                data-testid="build-error"
                style={{
                  margin: '0 0 16px',
                  padding: '10px 14px',
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
            <button
              type="submit"
              data-testid="build-detect"
              disabled={!url}
              style={primaryButton(!url)}
            >
              Detect spec
            </button>
          </form>
        )}

        {step === 'review' && detected && (
          <div data-testid="build-step-review">
            <div
              style={{
                background: 'var(--card)',
                border: '1px solid var(--line)',
                borderRadius: 12,
                padding: 20,
                marginBottom: 16,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  marginBottom: 12,
                  fontSize: 12,
                  color: 'var(--muted)',
                }}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M3 8l3 3 7-7" stroke="#1a7f37" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Detected {detected.tools_count} tool{detected.tools_count === 1 ? '' : 's'} ·{' '}
                auth: <code style={{ fontFamily: 'JetBrains Mono, monospace' }}>{detected.auth_type || 'none'}</code>
              </div>
              <ul
                style={{
                  margin: 0,
                  padding: 0,
                  listStyle: 'none',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                  maxHeight: 180,
                  overflowY: 'auto',
                }}
                data-testid="detected-actions"
              >
                {detected.actions.slice(0, 20).map((a) => (
                  <li
                    key={a.name}
                    style={{
                      fontSize: 13,
                      color: 'var(--ink)',
                      fontFamily: 'JetBrains Mono, monospace',
                    }}
                  >
                    <strong>{a.name}</strong>
                    {a.description && (
                      <span style={{ color: 'var(--muted)', fontFamily: 'Inter, sans-serif' }}>
                        {' '}
                        — {a.description}
                      </span>
                    )}
                  </li>
                ))}
                {detected.actions.length > 20 && (
                  <li style={{ fontSize: 12, color: 'var(--muted)' }}>
                    …and {detected.actions.length - 20} more
                  </li>
                )}
              </ul>
            </div>

            <Label>App name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              data-testid="build-name"
            />

            <Label>Slug (URL path)</Label>
            <Input
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
              data-testid="build-slug"
            />

            <Label>Description</Label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              data-testid="build-description"
              style={{
                width: '100%',
                padding: '10px 12px',
                border: '1px solid var(--line)',
                borderRadius: 8,
                background: 'var(--card)',
                fontSize: 14,
                color: 'var(--ink)',
                fontFamily: 'inherit',
                resize: 'vertical',
                minHeight: 80,
                boxSizing: 'border-box',
              }}
            />

            <Label>Category (optional)</Label>
            <Input
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="e.g. travel, coding, productivity"
              data-testid="build-category"
            />

            {error && (
              <p
                data-testid="build-error"
                style={{
                  margin: '16px 0 0',
                  padding: '10px 14px',
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

            <div style={{ display: 'flex', gap: 10, marginTop: 24 }}>
              <button
                type="button"
                onClick={() => setStep('paste')}
                style={{
                  padding: '11px 18px',
                  background: 'transparent',
                  border: '1px solid var(--line)',
                  borderRadius: 8,
                  fontSize: 13,
                  color: 'var(--muted)',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Back
              </button>
              <button
                type="button"
                onClick={handlePublish}
                data-testid="build-publish"
                disabled={!name || !slug}
                style={primaryButton(!name || !slug)}
              >
                Publish
              </button>
            </div>
          </div>
        )}

        {step === 'publishing' && (
          <div data-testid="build-step-publishing" style={{ padding: 40, textAlign: 'center' }}>
            <p style={{ fontSize: 14, color: 'var(--muted)' }}>Publishing...</p>
          </div>
        )}

        {step === 'done' && (
          <div
            data-testid="build-step-done"
            style={{
              padding: 32,
              textAlign: 'center',
              background: '#e6f4ea',
              border: '1px solid #b5dcc4',
              borderRadius: 12,
            }}
          >
            <div style={{ color: '#1a7f37', fontSize: 20, fontWeight: 700, marginBottom: 8 }}>
              Published
            </div>
            <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>
              Redirecting to /p/{slug}...
            </p>
          </div>
        )}
      </div>
    </PageShell>
  );
}

function StepBadge({ active, done, label }: { active: boolean; done: boolean; label: string }) {
  return (
    <span
      style={{
        padding: '6px 12px',
        borderRadius: 999,
        fontWeight: 600,
        background: done ? '#e6f4ea' : active ? 'var(--accent-soft, #e9e6ff)' : 'var(--bg)',
        color: done ? '#1a7f37' : active ? 'var(--accent)' : 'var(--muted)',
        border: '1px solid var(--line)',
      }}
    >
      {label}
    </span>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <label
      style={{
        display: 'block',
        fontSize: 12,
        fontWeight: 600,
        color: 'var(--muted)',
        marginBottom: 6,
        marginTop: 14,
      }}
    >
      {children}
    </label>
  );
}

function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      style={{
        width: '100%',
        padding: '10px 12px',
        border: '1px solid var(--line)',
        borderRadius: 8,
        background: 'var(--card)',
        fontSize: 14,
        color: 'var(--ink)',
        fontFamily: 'inherit',
        boxSizing: 'border-box',
        ...(props.style || {}),
      }}
    />
  );
}

function primaryButton(disabled: boolean): React.CSSProperties {
  return {
    padding: '11px 20px',
    background: 'var(--ink)',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontFamily: 'inherit',
    opacity: disabled ? 0.5 : 1,
  };
}
