import { useEffect, useState } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import { TopBar } from '../components/TopBar';
import { Footer } from '../components/Footer';
import { FloomApp } from '../components/FloomApp';
import { AppIcon } from '../components/AppIcon';
import { AppReviews } from '../components/AppReviews';
import { FeedbackButton } from '../components/FeedbackButton';
import { getApp } from '../api/client';
import type { AppDetail } from '../lib/types';

type Tab = 'run' | 'endpoints' | 'source';

// Map of known app slugs to GitHub repo URLs
const GITHUB_REPOS: Record<string, string> = {
  flyfast: 'https://github.com/floomhq/floom-monorepo/tree/main/examples/flyfast',
  opendraft: 'https://github.com/floomhq/floom-monorepo/tree/main/examples/opendraft',
  openslides: 'https://github.com/floomhq/floom-monorepo/tree/main/examples/openslides',
  'blast-radius': 'https://github.com/floomhq/floom-monorepo/tree/main/examples/blast-radius',
  bouncer: 'https://github.com/floomhq/floom-monorepo/tree/main/examples/bouncer',
  openanalytics: 'https://github.com/floomhq/floom-monorepo/tree/main/examples/openanalytics',
};

export function AppPermalinkPage() {
  const { slug } = useParams<{ slug: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = (searchParams.get('tab') as Tab) || 'run';

  const [app, setApp] = useState<AppDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [comingSoonTarget, setComingSoonTarget] = useState<null | 'chatgpt' | 'notion'>(null);

  useEffect(() => {
    if (!slug) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    getApp(slug)
      .then((a) => {
        setApp(a);
        setLoading(false);
      })
      .catch(() => {
        setNotFound(true);
        setLoading(false);
      });
  }, [slug]);

  // SEO meta
  useEffect(() => {
    if (!app) return;
    document.title = `${app.name} | Floom`;
    const setMeta = (name: string, content: string, prop = false) => {
      const attr = prop ? 'property' : 'name';
      let el = document.querySelector(`meta[${attr}="${name}"]`);
      if (!el) {
        el = document.createElement('meta');
        el.setAttribute(attr, name);
        document.head.appendChild(el);
      }
      el.setAttribute('content', content);
    };
    setMeta('description', app.description);
    setMeta('og:title', `${app.name} | Floom`, true);
    setMeta('og:description', app.description, true);
    setMeta('og:url', `https://preview.floom.dev/p/${app.slug}`, true);
    setMeta('og:type', 'website', true);

    const existing = document.getElementById('jsonld-app');
    if (existing) existing.remove();
    const script = document.createElement('script');
    script.id = 'jsonld-app';
    script.type = 'application/ld+json';
    script.textContent = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: app.name,
      description: app.description,
      applicationCategory: app.category || 'UtilitiesApplication',
      url: `https://preview.floom.dev/p/${app.slug}`,
      author: { '@type': 'Person', name: app.author || 'floomhq' },
    });
    document.head.appendChild(script);

    return () => {
      document.title = 'Floom: production layer for AI apps';
      const s = document.getElementById('jsonld-app');
      if (s) s.remove();
    };
  }, [app]);

  const setTab = (tab: Tab) => {
    setSearchParams({ tab }, { replace: true });
  };

  if (loading) {
    return (
      <div className="page-root">
        <TopBar />
        <main className="main" style={{ paddingTop: 80, textAlign: 'center' }}>
          <p style={{ color: 'var(--muted)', fontSize: 14 }}>Loading...</p>
        </main>
        <Footer />
      </div>
    );
  }

  if (notFound || !app) {
    return (
      <div className="page-root">
        <TopBar />
        <main className="main" style={{ paddingTop: 80, textAlign: 'center', maxWidth: 480, margin: '0 auto' }}>
          <h1 style={{ fontSize: 32, fontWeight: 700, margin: '0 0 12px' }}>404</h1>
          <p style={{ color: 'var(--muted)', fontSize: 16, margin: '0 0 32px' }}>
            No app found at <code style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 13 }}>/p/{slug}</code>
          </p>
          <Link
            to="/apps"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '10px 20px',
              background: 'var(--accent)',
              color: '#fff',
              borderRadius: 8,
              fontSize: 14,
              fontWeight: 600,
              textDecoration: 'none',
            }}
          >
            Back to all apps
          </Link>
        </main>
        <Footer />
      </div>
    );
  }

  const mcpEndpoint = `https://preview.floom.dev/mcp/app/${app.slug}`;
  const httpEndpoint = `https://preview.floom.dev/api/run`;
  const githubRepo = GITHUB_REPOS[app.slug];
  const manifestUrl = `https://github.com/floomhq/floom-monorepo/tree/main/examples/${app.slug}/floom.yaml`;

  // Claude Desktop's stable config format accepts stdio servers with
  // `command`/`args`. Wrap the remote HTTP MCP URL with `mcp-remote` (the
  // official Anthropic HTTP bridge).
  const claudeDesktopSnippet = JSON.stringify(
    {
      mcpServers: {
        [`floom-${app.slug}`]: {
          command: 'npx',
          args: ['-y', 'mcp-remote', mcpEndpoint],
        },
      },
    },
    null,
    2,
  );

  const firstAction = Object.keys(app.manifest?.actions ?? {})[0] || (app.actions?.[0]) || 'run';
  const curlExample = `curl -X POST ${httpEndpoint} \\
  -H "Content-Type: application/json" \\
  -d '{"app_slug":"${app.slug}","action":"${firstAction}","inputs":{}}'`;

  const TABS: { id: Tab; label: string }[] = [
    { id: 'run', label: 'Run' },
    { id: 'endpoints', label: 'Endpoints' },
    { id: 'source', label: 'Source' },
  ];

  return (
    <div className="page-root">
      <TopBar />

      <main
        style={{ padding: '32px 24px 80px', maxWidth: 900, margin: '0 auto' }}
        data-testid="permalink-page"
      >
        {/* Breadcrumb */}
        <div style={{ marginBottom: 24 }}>
          <Link
            to="/apps"
            style={{ fontSize: 13, color: 'var(--muted)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            <svg width={12} height={12} viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path d="M8 2L4 6l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            All apps
          </Link>
        </div>

        {/* App header */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 14,
              border: '1px solid var(--line)',
              background: 'var(--bg)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto 16px',
            }}
          >
            <AppIcon slug={app.slug} size={32} />
          </div>
          <h1 style={{ fontSize: 28, fontWeight: 700, margin: '0 0 8px', color: 'var(--ink)' }}>{app.name}</h1>
          <p style={{ fontSize: 15, color: 'var(--muted)', margin: '0 0 12px', maxWidth: 500, marginLeft: 'auto', marginRight: 'auto', lineHeight: 1.55 }}>
            {app.description}
          </p>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, flexWrap: 'wrap', fontSize: 12, color: 'var(--muted)' }}>
            {app.author && <span>@{app.author}</span>}
            {app.category && <span>{app.category}</span>}
            {app.runtime && <span style={{ fontFamily: 'JetBrains Mono, monospace' }}>{app.runtime}</span>}
            {githubRepo && (
              <a
                href={githubRepo}
                target="_blank"
                rel="noreferrer"
                style={{ color: 'var(--accent)', textDecoration: 'none', fontWeight: 500 }}
              >
                View on GitHub
              </a>
            )}
          </div>
        </div>

        {/* Tab bar */}
        <div
          style={{
            display: 'flex',
            gap: 0,
            borderBottom: '2px solid var(--line)',
            marginBottom: 32,
            overflowX: 'auto',
            flexWrap: 'nowrap',
          }}
          role="tablist"
          aria-label="App tabs"
        >
          {TABS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={activeTab === id}
              data-testid={`tab-${id}`}
              onClick={() => setTab(id)}
              style={{
                padding: '10px 20px',
                background: 'none',
                border: 'none',
                borderBottom: activeTab === id ? '2px solid var(--accent)' : '2px solid transparent',
                marginBottom: -2,
                fontSize: 14,
                fontWeight: activeTab === id ? 600 : 400,
                color: activeTab === id ? 'var(--ink)' : 'var(--muted)',
                cursor: 'pointer',
                fontFamily: 'inherit',
                whiteSpace: 'nowrap',
                transition: 'color 0.1s',
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Tab content */}

        {/* Run tab */}
        {activeTab === 'run' && (
          <div data-testid="tab-content-run">
            <FloomApp
              app={app}
              standalone={true}
              showSidebar={false}
            />
          </div>
        )}

        {/* Endpoints tab */}
        {activeTab === 'endpoints' && (
          <div data-testid="tab-content-endpoints" style={{ maxWidth: 700 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              {/* MCP */}
              <EndpointCard
                label="MCP"
                title="Model Context Protocol"
                desc="Use this app as a tool in Claude, Cursor, or any MCP-compatible agent."
                value={mcpEndpoint}
                ctaLabel="Add to Claude Desktop"
                ctaHref="https://docs.anthropic.com/en/docs/claude-desktop"
              />

              {/* Add to ChatGPT (coming soon) */}
              <AddToProviderRow
                label="ChatGPT"
                title="Add to ChatGPT"
                desc="One-click install into your ChatGPT custom GPT."
                onClick={() => setComingSoonTarget('chatgpt')}
                testId="add-to-chatgpt"
              />

              {/* Add to Notion (coming soon) */}
              <AddToProviderRow
                label="Notion"
                title="Add to Notion"
                desc="Embed this app as a Notion block with the Floom connector."
                onClick={() => setComingSoonTarget('notion')}
                testId="add-to-notion"
              />

              {/* HTTP */}
              <div
                style={{
                  background: 'var(--card)',
                  border: '1px solid var(--line)',
                  borderRadius: 12,
                  padding: '20px 24px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                  <div>
                    <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>HTTP API</span>
                    <p style={{ margin: '4px 0 0', fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>REST endpoint</p>
                  </div>
                </div>
                <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--muted)' }}>
                  POST to run the app from any HTTP client.
                </p>
                <CodeBlock code={curlExample} />
              </div>

              {/* CLI */}
              <div
                style={{
                  background: 'var(--card)',
                  border: '1px solid var(--line)',
                  borderRadius: 12,
                  padding: '20px 24px',
                }}
              >
                <div style={{ marginBottom: 12 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>CLI</span>
                  <p style={{ margin: '4px 0 0', fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>Command line</p>
                </div>
                <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--muted)' }}>
                  Run from a self-hosted instance.
                </p>
                <CodeBlock code={`floom run ${app.slug}`} />
              </div>

              {/* Claude Desktop config */}
              <div
                style={{
                  background: 'var(--card)',
                  border: '1px solid var(--line)',
                  borderRadius: 12,
                  padding: '20px 24px',
                }}
              >
                <p style={{ margin: '0 0 4px', fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>
                  Paste into Claude Desktop config
                </p>
                <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--muted)' }}>
                  Add to <code style={{ fontFamily: 'JetBrains Mono, monospace' }}>~/Library/Application Support/Claude/claude_desktop_config.json</code>
                </p>
                <CodeBlock code={claudeDesktopSnippet} />
              </div>
            </div>
          </div>
        )}

        {/* Source tab */}
        {activeTab === 'source' && (
          <div data-testid="tab-content-source" style={{ maxWidth: 600 }}>
            <div
              style={{
                background: 'var(--card)',
                border: '1px solid var(--line)',
                borderRadius: 12,
                padding: '24px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
                <svg width={18} height={18} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <use href="#icon-github" />
                </svg>
                <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: 'var(--ink)' }}>Open source on GitHub</p>
              </div>

              {githubRepo ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <a
                    href={githubRepo}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '9px 18px',
                      background: 'var(--ink)',
                      color: '#fff',
                      borderRadius: 8,
                      fontSize: 13,
                      fontWeight: 600,
                      textDecoration: 'none',
                      alignSelf: 'flex-start',
                    }}
                  >
                    View source
                  </a>
                  <a
                    href={manifestUrl}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      fontSize: 13,
                      fontFamily: 'JetBrains Mono, monospace',
                      color: 'var(--accent)',
                      textDecoration: 'none',
                      padding: '6px 12px',
                      border: '1px solid var(--line)',
                      borderRadius: 6,
                      background: 'var(--bg)',
                      alignSelf: 'flex-start',
                      display: 'inline-block',
                    }}
                  >
                    examples/{app.slug}/floom.yaml
                  </a>
                </div>
              ) : (
                <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>
                  Source repo not listed for this app.
                </p>
              )}
            </div>
          </div>
        )}

        {/* W4-minimal: reviews section (renders on every tab) */}
        <AppReviews slug={app.slug} />
      </main>
      <Footer />
      <FeedbackButton />

      {comingSoonTarget && (
        <ComingSoonModal
          target={comingSoonTarget}
          mcpUrl={mcpEndpoint}
          onClose={() => setComingSoonTarget(null)}
        />
      )}
    </div>
  );
}

// Shared components

function EndpointCard({
  label,
  title,
  desc,
  value,
  ctaLabel,
  ctaHref,
}: {
  label: string;
  title: string;
  desc: string;
  value: string;
  ctaLabel?: string;
  ctaHref?: string;
}) {
  return (
    <div
      style={{
        background: 'var(--card)',
        border: '1px solid var(--line)',
        borderRadius: 12,
        padding: '20px 24px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12, gap: 12, flexWrap: 'wrap' }}>
        <div>
          <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>{label}</span>
          <p style={{ margin: '4px 0 4px', fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>{title}</p>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>{desc}</p>
        </div>
        {ctaLabel && ctaHref && (
          <a
            href={ctaHref}
            target="_blank"
            rel="noreferrer"
            style={{
              fontSize: 12,
              color: 'var(--accent)',
              textDecoration: 'none',
              fontWeight: 500,
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
          >
            {ctaLabel}
          </a>
        )}
      </div>
      <CopyRow value={value} />
    </div>
  );
}

function CopyRow({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    try { navigator.clipboard.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); } catch { /* ignore */ }
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <code
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 12,
          fontFamily: 'JetBrains Mono, monospace',
          color: 'var(--ink)',
          background: 'var(--bg)',
          border: '1px solid var(--line)',
          borderRadius: 6,
          padding: '7px 10px',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          display: 'block',
        }}
      >
        {value}
      </code>
      <button
        type="button"
        onClick={handleCopy}
        style={{
          padding: '6px 12px',
          background: 'var(--bg)',
          border: '1px solid var(--line)',
          borderRadius: 6,
          fontSize: 11,
          cursor: 'pointer',
          fontFamily: 'inherit',
          color: copied ? 'var(--success, #16a34a)' : 'var(--muted)',
          transition: 'color 0.15s',
          flexShrink: 0,
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

function AddToProviderRow({
  label,
  title,
  desc,
  onClick,
  testId,
}: {
  label: string;
  title: string;
  desc: string;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      style={{
        background: 'var(--card)',
        border: '1px solid var(--line)',
        borderRadius: 12,
        padding: '20px 24px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
        width: '100%',
        textAlign: 'left',
        cursor: 'pointer',
        fontFamily: 'inherit',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
          {label}
        </span>
        <p style={{ margin: '4px 0 4px', fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>
          {title}
        </p>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>{desc}</p>
      </div>
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 10px',
          borderRadius: 999,
          background: 'var(--accent-soft)',
          color: 'var(--accent)',
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          whiteSpace: 'nowrap',
          flexShrink: 0,
        }}
      >
        Coming soon
      </span>
    </button>
  );
}

function ComingSoonModal({
  target,
  mcpUrl,
  onClose,
}: {
  target: 'chatgpt' | 'notion';
  mcpUrl: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const copy = () => {
    try {
      navigator.clipboard.writeText(mcpUrl).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      });
    } catch {
      /* ignore */
    }
  };

  const providerLabel = target === 'chatgpt' ? 'ChatGPT' : 'Notion';
  const instructions =
    target === 'chatgpt'
      ? 'One-click install is coming soon. For now, copy the MCP URL and paste it into your ChatGPT custom GPT instructions under "Actions".'
      : 'One-click install is coming soon. For now, copy the MCP URL and paste it into the Floom connector block in your Notion page.';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="coming-soon-title"
      data-testid={`coming-soon-modal-${target}`}
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(14, 14, 12, 0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--card)',
          border: '1px solid var(--line)',
          borderRadius: 14,
          padding: '28px 28px 24px',
          maxWidth: 460,
          width: '100%',
          boxShadow: '0 20px 60px rgba(0,0,0,0.15)',
        }}
      >
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 10px',
            borderRadius: 999,
            background: 'var(--accent-soft)',
            color: 'var(--accent)',
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            marginBottom: 14,
          }}
        >
          Coming soon
        </div>
        <h2
          id="coming-soon-title"
          style={{
            fontSize: 20,
            fontWeight: 700,
            margin: '0 0 10px',
            color: 'var(--ink)',
          }}
        >
          Add to {providerLabel}
        </h2>
        <p
          style={{
            fontSize: 14,
            color: 'var(--muted)',
            margin: '0 0 20px',
            lineHeight: 1.55,
          }}
        >
          {instructions}
        </p>
        <div
          style={{
            background: 'var(--bg)',
            border: '1px solid var(--line)',
            borderRadius: 8,
            padding: '10px 12px',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            marginBottom: 18,
          }}
        >
          <code
            style={{
              flex: 1,
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 12,
              color: 'var(--ink)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {mcpUrl}
          </code>
          <button
            type="button"
            onClick={copy}
            data-testid="coming-soon-copy-mcp"
            style={{
              padding: '6px 12px',
              background: 'var(--accent)',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
              flexShrink: 0,
            }}
          >
            {copied ? 'Copied' : 'Copy MCP URL'}
          </button>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: '8px 18px',
              background: 'transparent',
              color: 'var(--muted)',
              border: '1px solid var(--line)',
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 500,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    try { navigator.clipboard.writeText(code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); } catch { /* ignore */ }
  };
  return (
    <div style={{ position: 'relative' }}>
      <pre
        style={{
          background: 'var(--terminal-bg, #0e0e0c)',
          color: 'var(--terminal-ink, #d4d4c8)',
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 12,
          padding: '16px',
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
        onClick={handleCopy}
        style={{
          position: 'absolute', top: 8, right: 8,
          fontSize: 10, padding: '3px 8px',
          background: 'rgba(255,255,255,0.1)',
          border: '1px solid rgba(255,255,255,0.15)',
          borderRadius: 4,
          color: copied ? '#7bffc0' : 'rgba(255,255,255,0.5)',
          cursor: 'pointer', fontFamily: 'inherit', transition: 'color 0.15s',
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
