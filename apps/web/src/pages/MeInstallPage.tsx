// v15.1 /me/install — dedicated page for the Install to Claude Desktop
// flow. The UI here is lifted verbatim from the old MePage "install" tab
// so the rebuild doesn't regress a live feature. New /me is a
// threads-first shell, so this flow lives at its own route.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageShell } from '../components/PageShell';
import * as api from '../api/client';
import type { MeRunSummary } from '../lib/types';

export function MeInstallPage() {
  const origin =
    typeof window !== 'undefined'
      ? window.location.origin
      : 'https://preview.floom.dev';
  const mcpUrl = `${origin}/mcp`;

  const [runs, setRuns] = useState<MeRunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);

  useEffect(() => {
    api
      .getMyRuns(50)
      .then((res) => setRuns(res.runs))
      .catch((err) => setError((err as Error).message));
  }, []);

  const recentApps: Array<{ slug: string; name: string }> = [];
  if (runs) {
    const seen = new Set<string>();
    for (const r of runs) {
      if (!r.app_slug || seen.has(r.app_slug)) continue;
      seen.add(r.app_slug);
      recentApps.push({ slug: r.app_slug, name: r.app_name || r.app_slug });
      if (recentApps.length >= 5) break;
    }
  }

  const activeSlug = selectedSlug || recentApps[0]?.slug || null;
  const activeApp = recentApps.find((a) => a.slug === activeSlug) || null;

  function buildConfigFor(slug: string): string {
    return JSON.stringify(
      {
        mcpServers: {
          [`floom-${slug}`]: {
            command: 'npx',
            args: ['-y', 'mcp-remote', `${origin}/mcp/app/${slug}`],
          },
        },
      },
      null,
      2,
    );
  }

  return (
    <PageShell requireAuth="cloud" title="Install to Claude | Floom">
      <div data-testid="install-page" style={{ maxWidth: 680 }}>
        <nav
          aria-label="Breadcrumb"
          style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 16 }}
        >
          <Link to="/me" style={{ color: 'var(--muted)', textDecoration: 'none' }}>
            /me
          </Link>
          <span style={{ margin: '0 6px' }}>›</span>
          <span style={{ color: 'var(--ink)' }}>Install to Claude</span>
        </nav>

        <h1
          className="section-title-display"
          style={{ fontSize: 32, margin: '0 0 6px' }}
        >
          Install to Claude Desktop
        </h1>
        <p
          style={{
            fontSize: 14,
            color: 'var(--muted)',
            margin: '0 0 24px',
            lineHeight: 1.6,
          }}
        >
          Pick an app you've run, then paste its config into your{' '}
          <code
            style={{
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 12,
              background: 'var(--bg)',
              padding: '2px 6px',
              borderRadius: 4,
            }}
          >
            claude_desktop_config.json
          </code>{' '}
          and restart Claude Desktop.
        </p>

        <div
          style={{
            background: 'var(--card)',
            border: '1px solid var(--line)',
            borderRadius: 12,
            padding: '16px 20px',
            marginBottom: 16,
          }}
        >
          <div style={stepLabelStyle}>Step 1: MCP URL</div>
          <CopyRow value={mcpUrl} />
        </div>

        {error && <ErrorCard title="Couldn't load your apps" message={error} />}

        {!runs && !error && (
          <div
            data-testid="install-loading"
            style={{
              background: 'var(--card)',
              border: '1px solid var(--line)',
              borderRadius: 12,
              padding: '16px 20px',
              marginBottom: 16,
              fontSize: 13,
              color: 'var(--muted)',
            }}
          >
            Loading your apps…
          </div>
        )}

        {runs && recentApps.length === 0 && (
          <div
            data-testid="install-empty"
            style={{
              background: 'var(--card)',
              border: '1px dashed var(--line)',
              borderRadius: 12,
              padding: '24px 20px',
              marginBottom: 16,
            }}
          >
            <div
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: 'var(--ink)',
                marginBottom: 6,
              }}
            >
              No apps to install yet
            </div>
            <p
              style={{
                fontSize: 13,
                color: 'var(--muted)',
                margin: '0 0 14px',
                lineHeight: 1.55,
              }}
            >
              Run an app from the store first. Each app you run unlocks its own
              install config here.
            </p>
            <Link
              to="/apps"
              style={{
                display: 'inline-block',
                padding: '8px 14px',
                background: 'var(--ink)',
                color: '#fff',
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 600,
                textDecoration: 'none',
              }}
            >
              Browse apps
            </Link>
          </div>
        )}

        {recentApps.length > 0 && activeApp && (
          <>
            <div
              style={{
                background: 'var(--card)',
                border: '1px solid var(--line)',
                borderRadius: 12,
                padding: '16px 20px',
                marginBottom: 16,
              }}
            >
              <div style={stepLabelStyle}>Step 2: Pick an app</div>
              <div
                role="tablist"
                aria-label="Recent apps"
                style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}
              >
                {recentApps.map((a) => {
                  const isActive = a.slug === activeSlug;
                  return (
                    <button
                      key={a.slug}
                      type="button"
                      role="tab"
                      aria-selected={isActive}
                      data-testid={`install-app-${a.slug}`}
                      onClick={() => setSelectedSlug(a.slug)}
                      style={{
                        padding: '6px 12px',
                        fontSize: 12,
                        fontWeight: 600,
                        borderRadius: 999,
                        border: '1px solid var(--line)',
                        background: isActive ? 'var(--ink)' : 'var(--bg)',
                        color: isActive ? '#fff' : 'var(--ink)',
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                      }}
                    >
                      {a.name}
                    </button>
                  );
                })}
              </div>
            </div>

            <div
              style={{
                background: 'var(--card)',
                border: '1px solid var(--line)',
                borderRadius: 12,
                padding: '16px 20px',
                marginBottom: 16,
              }}
            >
              <div style={stepLabelStyle}>Step 3: Paste into config</div>
              <CodeBlock
                key={activeApp.slug}
                code={buildConfigFor(activeApp.slug)}
              />
            </div>

            <div
              style={{
                background: 'var(--card)',
                border: '1px solid var(--line)',
                borderRadius: 12,
                padding: '16px 20px',
              }}
            >
              <div style={stepLabelStyle}>Step 4 — Test from HTTP</div>
              <CodeBlock
                key={`${activeApp.slug}-curl`}
                code={`curl -X POST ${origin}/api/${activeApp.slug}/run \\
  -H "Content-Type: application/json" \\
  -d '{"action":"","inputs":{}}'`}
              />
            </div>
          </>
        )}
      </div>
    </PageShell>
  );
}

const stepLabelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: 'var(--muted)',
  marginBottom: 10,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
};

function CopyRow({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    try {
      void navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // no-op
    }
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <code
        style={{
          flex: 1,
          fontSize: 12,
          fontFamily: 'JetBrains Mono, monospace',
          color: 'var(--ink)',
          background: 'var(--bg)',
          border: '1px solid var(--line)',
          borderRadius: 6,
          padding: '8px 12px',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {value}
      </code>
      <button
        type="button"
        onClick={copy}
        style={{
          padding: '6px 12px',
          background: 'var(--bg)',
          border: '1px solid var(--line)',
          borderRadius: 6,
          fontSize: 11,
          color: copied ? '#1a7f37' : 'var(--muted)',
          cursor: 'pointer',
          fontFamily: 'inherit',
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    try {
      void navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // no-op
    }
  }
  return (
    <div style={{ position: 'relative' }}>
      <pre
        style={{
          background: '#0e0e0c',
          color: '#d4d4c8',
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 12,
          padding: 16,
          borderRadius: 8,
          overflowX: 'auto',
          lineHeight: 1.7,
          margin: 0,
          whiteSpace: 'pre',
        }}
      >
        {code}
      </pre>
      <button
        type="button"
        onClick={copy}
        style={{
          position: 'absolute',
          top: 8,
          right: 8,
          fontSize: 10,
          padding: '3px 8px',
          background: 'rgba(255,255,255,0.1)',
          border: '1px solid rgba(255,255,255,0.15)',
          borderRadius: 4,
          color: copied ? '#7bffc0' : 'rgba(255,255,255,0.5)',
          cursor: 'pointer',
          fontFamily: 'inherit',
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

function ErrorCard({ title, message }: { title: string; message: string }) {
  return (
    <div
      style={{
        background: '#fff8e6',
        border: '1px solid #f4e0a5',
        borderRadius: 10,
        padding: '14px 18px',
        color: '#755a00',
        marginBottom: 16,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 13, fontFamily: 'JetBrains Mono, monospace' }}>
        {message}
      </div>
    </div>
  );
}
