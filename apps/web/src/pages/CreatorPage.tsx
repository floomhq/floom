// W4-minimal: /creator — creator dashboard.
//
// Lists every app authored by the caller, with run count, last-run time,
// a delete button (with confirm modal), and an "Edit" / "View activity"
// link to /creator/:slug.
//
// Empty state links to /build.

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { PageShell } from '../components/PageShell';
import * as api from '../api/client';
import type { CreatorApp } from '../lib/types';
import { formatTime } from '../lib/time';

// Audit 2026-04-18, bug #6: creator dashboard cards used to render the
// app description via `{a.description}`, which meant any creator who had
// markdown in their description (bold, links, inline code) saw raw
// `[label](url)` / `**bold**` syntax in the card instead of clickable
// links and bolded text. We now parse a small inline-markdown subset
// (links, bold, inline code) into React nodes before rendering. This is
// intentionally NOT a full markdown parser: no block elements, no raw
// HTML, no images, no lists. The output is wrapped in line-clamp CSS
// that expects inline text only.
const LINK_STYLE: React.CSSProperties = {
  color: 'var(--ink)',
  textDecoration: 'underline',
  textDecorationThickness: '1px',
  textUnderlineOffset: '2px',
};
const CODE_STYLE: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: '0.92em',
  background: 'var(--bg)',
  padding: '0 4px',
  borderRadius: 3,
};
// Matches [text](http[s]://...), `code`, **bold**. Order matters: links
// first because they contain brackets that could otherwise get eaten.
const MD_INLINE_RE = /(\[[^\]]+\]\(https?:\/\/[^\s)]+\))|(`[^`]+`)|(\*\*[^*]+\*\*)/g;
function renderInlineMarkdown(src: string): ReactNode[] {
  const out: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  for (const m of src.matchAll(MD_INLINE_RE)) {
    if (m.index! > lastIndex) out.push(src.slice(lastIndex, m.index));
    const tok = m[0];
    if (tok.startsWith('[')) {
      const inner = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(tok);
      if (inner) {
        out.push(
          <a
            key={`md-${key++}`}
            href={inner[2]}
            target="_blank"
            rel="noreferrer"
            style={LINK_STYLE}
          >
            {inner[1]}
          </a>,
        );
      } else {
        out.push(tok);
      }
    } else if (tok.startsWith('`')) {
      out.push(
        <code key={`md-${key++}`} style={CODE_STYLE}>
          {tok.slice(1, -1)}
        </code>,
      );
    } else if (tok.startsWith('**')) {
      out.push(
        <strong key={`md-${key++}`} style={{ color: 'var(--ink)' }}>
          {tok.slice(2, -2)}
        </strong>,
      );
    }
    lastIndex = m.index! + tok.length;
  }
  if (lastIndex < src.length) out.push(src.slice(lastIndex));
  return out;
}

export function CreatorPage() {
  const [apps, setApps] = useState<CreatorApp[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmSlug, setConfirmSlug] = useState<string | null>(null);
  const [confirmInput, setConfirmInput] = useState('');
  const [deleting, setDeleting] = useState(false);

  async function load() {
    try {
      const res = await api.getMyApps();
      setApps(res.apps);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function handleDelete() {
    if (!confirmSlug) return;
    setDeleting(true);
    try {
      await api.deleteApp(confirmSlug);
      setConfirmSlug(null);
      setConfirmInput('');
      await load();
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <PageShell requireAuth="cloud" title="Creator dashboard | Floom" noIndex>
      <div data-testid="creator-page">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 24,
            gap: 16,
            flexWrap: 'wrap',
          }}
        >
          <div>
            <h1 style={{ fontSize: 28, fontWeight: 700, margin: '0 0 6px', color: 'var(--ink)' }}>
              Your apps
            </h1>
            <p style={{ fontSize: 14, color: 'var(--muted)', margin: 0 }}>
              Everything you've published. Edit, delete, or drill into activity.
            </p>
          </div>
          <Link
            to="/build"
            data-testid="creator-new-app"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '10px 16px',
              background: 'var(--ink)',
              color: '#fff',
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 600,
              textDecoration: 'none',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M7 2v10M2 7h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            Ship new app
          </Link>
        </div>

        {error && (
          <div
            style={{
              background: '#fdecea',
              border: '1px solid #f4b7b1',
              color: '#c2321f',
              borderRadius: 10,
              padding: '14px 18px',
              marginBottom: 20,
            }}
          >
            {error}
          </div>
        )}

        {!apps && !error && (
          <div data-testid="creator-loading" style={{ color: 'var(--muted)', padding: 32 }}>
            Loading...
          </div>
        )}

        {apps && apps.length === 0 && (
          <div
            data-testid="creator-empty"
            style={{
              textAlign: 'center',
              padding: '64px 24px',
              background: 'var(--card)',
              border: '1px dashed var(--line)',
              borderRadius: 12,
            }}
          >
            <div
              style={{
                width: 64,
                height: 64,
                borderRadius: 16,
                // Green tint fallback — the default #e9e6ff was purple,
                // which violates Floom's green-only accent rule.
                background: 'var(--accent-soft, #d7f1e0)',
                color: 'var(--accent)',
                margin: '0 auto 20px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M12 5v14M5 12h14"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </div>
            <h3 style={{ fontSize: 18, fontWeight: 700, color: 'var(--ink)', margin: '0 0 8px' }}>
              Ship your first app in 2 minutes
            </h3>
            <p
              style={{
                fontSize: 13,
                color: 'var(--muted)',
                margin: '0 auto 20px',
                maxWidth: 380,
                lineHeight: 1.55,
              }}
            >
              Paste your app's link. Floom gives you a Claude tool, a page to share, a CLI, and a URL your teammates can hit.
            </p>
            <Link
              to="/build"
              style={{
                display: 'inline-block',
                padding: '11px 20px',
                background: 'var(--ink)',
                color: '#fff',
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 600,
                textDecoration: 'none',
              }}
            >
              Start publishing
            </Link>
          </div>
        )}

        {apps && apps.length > 0 && (
          <div
            data-testid="creator-apps-list"
            style={{
              display: 'grid',
              gap: 14,
              gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
            }}
          >
            {apps.map((a) => (
              <div
                key={a.slug}
                data-testid={`creator-app-${a.slug}`}
                style={{
                  background: 'var(--card)',
                  border: '1px solid var(--line)',
                  borderRadius: 12,
                  padding: 20,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 12,
                }}
              >
                <div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--ink)', marginBottom: 4 }}>
                    {a.name}
                  </div>
                  <div style={{ fontSize: 12, fontFamily: 'JetBrains Mono, monospace', color: 'var(--muted)' }}>
                    /p/{a.slug}
                  </div>
                </div>
                <p
                  data-testid={`creator-desc-${a.slug}`}
                  style={{
                    fontSize: 13,
                    color: 'var(--muted)',
                    lineHeight: 1.5,
                    margin: 0,
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  }}
                >
                  {a.description ? renderInlineMarkdown(a.description) : '(no description)'}
                </p>
                <div
                  style={{
                    display: 'flex',
                    gap: 10,
                    fontSize: 12,
                    color: 'var(--muted)',
                    marginTop: 'auto',
                    paddingTop: 8,
                    borderTop: '1px solid var(--line)',
                  }}
                >
                  <span>
                    <strong style={{ color: 'var(--ink)' }}>{a.run_count}</strong> runs
                  </span>
                  <span>·</span>
                  <span>{a.last_run_at ? `last ${formatTime(a.last_run_at)}` : 'never run'}</span>
                </div>
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    gap: 6,
                    justifyContent: 'space-between',
                    rowGap: 8,
                  }}
                >
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <Link
                      to={`/creator/${a.slug}`}
                      style={secondaryBtnStyle}
                      data-testid={`creator-activity-${a.slug}`}
                    >
                      Activity
                    </Link>
                    <Link
                      to={`/build?edit=${a.slug}`}
                      style={secondaryBtnStyle}
                    >
                      Edit
                    </Link>
                    <Link
                      to={`/p/${a.slug}`}
                      style={secondaryBtnStyle}
                    >
                      View
                    </Link>
                  </div>
                  <button
                    type="button"
                    onClick={() => setConfirmSlug(a.slug)}
                    data-testid={`creator-delete-${a.slug}`}
                    style={creatorDeleteTertiaryStyle}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {confirmSlug && (
          <div
            role="dialog"
            aria-modal="true"
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 1000,
              background: 'rgba(0,0,0,0.4)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 16,
            }}
            onClick={() => setConfirmSlug(null)}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                background: 'var(--card)',
                borderRadius: 12,
                padding: 24,
                maxWidth: 440,
                width: '100%',
              }}
            >
              <h3 style={{ margin: '0 0 8px', fontSize: 16, color: 'var(--ink)' }}>
                Delete {confirmSlug}?
              </h3>
              <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--muted)', lineHeight: 1.55 }}>
                Removes the app from the store and drops run history. Cannot be undone.
                Type the slug <code style={{ fontFamily: 'JetBrains Mono, monospace' }}>{confirmSlug}</code> to confirm.
              </p>
              <input
                value={confirmInput}
                onChange={(e) => setConfirmInput(e.target.value)}
                autoFocus
                data-testid="creator-delete-confirm"
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  border: '1px solid var(--line)',
                  borderRadius: 8,
                  background: 'var(--card)',
                  fontSize: 14,
                  fontFamily: 'JetBrains Mono, monospace',
                  color: 'var(--ink)',
                  boxSizing: 'border-box',
                }}
              />
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
                <button
                  type="button"
                  onClick={() => {
                    setConfirmSlug(null);
                    setConfirmInput('');
                  }}
                  style={{
                    padding: '8px 16px',
                    background: 'transparent',
                    border: '1px solid var(--line)',
                    borderRadius: 8,
                    fontSize: 13,
                    color: 'var(--muted)',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={confirmInput !== confirmSlug || deleting}
                  data-testid="creator-delete-submit"
                  style={{
                    padding: '8px 16px',
                    background: 'transparent',
                    color: '#a02818',
                    border: '1px solid #c2321f',
                    borderRadius: 8,
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: confirmInput === confirmSlug && !deleting ? 'pointer' : 'not-allowed',
                    fontFamily: 'inherit',
                    opacity: confirmInput === confirmSlug && !deleting ? 1 : 0.5,
                  }}
                >
                  {deleting ? 'Deleting...' : 'Delete forever'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </PageShell>
  );
}

const secondaryBtnStyle: React.CSSProperties = {
  padding: '6px 12px',
  background: 'var(--bg)',
  border: '1px solid var(--line)',
  borderRadius: 6,
  fontSize: 12,
  color: 'var(--muted)',
  fontFamily: 'inherit',
  textDecoration: 'none',
  flex: 1,
  textAlign: 'center',
  whiteSpace: 'nowrap',
};

/** Tertiary — visually subordinate to Edit / View (issue #110). */
const creatorDeleteTertiaryStyle: React.CSSProperties = {
  padding: '4px 8px',
  fontSize: 12,
  color: 'var(--muted)',
  background: 'transparent',
  border: 'none',
  fontFamily: 'inherit',
  cursor: 'pointer',
  textDecoration: 'underline',
  textDecorationColor: 'rgba(88, 85, 80, 0.35)',
  textUnderlineOffset: '2px',
  whiteSpace: 'nowrap',
};
