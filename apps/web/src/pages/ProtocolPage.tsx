import React, { useState, useRef } from 'react';
import { Link } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { TopBar } from '../components/TopBar';
import { Footer } from '../components/Footer';
import { FeedbackButton } from '../components/FeedbackButton';
import { PageHead } from '../components/PageHead';
// Import the protocol markdown at build time via Vite ?raw
import protocolMd from '../assets/protocol.md?raw';

// ── Markdown rendering ─────────────────────────────────────────────────────
// Uses `react-markdown` (CSP-safe, no HTML injection) with custom
// renderers that preserve the page's visual style. Heading IDs are
// generated so the TOC anchors keep working.

interface TocItem {
  id: string;
  text: string;
  level: number;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
}

function extractToc(md: string): TocItem[] {
  const lines = md.split('\n');
  const toc: TocItem[] = [];
  for (const line of lines) {
    const m = line.match(/^(#{1,3})\s+(.+)/);
    if (m) {
      const level = m[1].length;
      const text = m[2].replace(/`/g, '');
      toc.push({ id: slugify(text), text, level });
    }
  }
  return toc;
}

// Pull plain text out of react-markdown's ReactNode children (for slug IDs).
function childrenToText(children: React.ReactNode): string {
  if (typeof children === 'string') return children;
  if (typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(childrenToText).join('');
  if (React.isValidElement(children)) {
    return childrenToText((children.props as { children?: React.ReactNode }).children);
  }
  return '';
}

function CopyCodeButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      data-testid="copy-btn"
      onClick={() => {
        try {
          navigator.clipboard.writeText(code).catch(() => {});
        } catch {
          // ignore
        }
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      style={{
        position: 'absolute',
        top: 10,
        right: 10,
        fontSize: 11,
        padding: '3px 10px',
        background: 'var(--card)',
        border: '1px solid var(--line)',
        borderRadius: 6,
        color: copied ? 'var(--accent)' : 'var(--muted)',
        cursor: 'pointer',
        fontFamily: 'inherit',
        transition: 'color 0.15s',
      }}
    >
      {copied ? 'Copied!' : 'Copy'}
    </button>
  );
}

// ── Flow Diagram ───────────────────────────────────────────────────────────

function FlowDiagram() {
  return (
    <div
      className="protocol-flow-diagram"
      style={{ marginBottom: 36, maxWidth: '100%', minWidth: 0, height: 'auto' }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', margin: '0 0 16px' }}>
        <p style={{ margin: 0, fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          How it works
        </p>
        <p
          aria-hidden="true"
          className="protocol-flow-scroll-hint"
          style={{ margin: 0, fontSize: 10, color: 'var(--muted)', display: 'none', fontFamily: 'JetBrains Mono, monospace' }}
        >
          ← scroll →
        </p>
      </div>
      <div
        className="protocol-flow-diagram-inner"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 0,
          flexWrap: 'nowrap',
          overflowX: 'auto',
          paddingBottom: 4,
          maxWidth: '100%',
          minWidth: 0,
          height: 'auto',
        }}
      >
        {/* Input box */}
        <div style={{
          background: 'var(--bg)',
          border: '1px solid var(--line)',
          borderRadius: 8,
          padding: '10px 16px',
          textAlign: 'center',
          flexShrink: 0,
        }}>
          <p style={{ margin: 0, fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Input</p>
          <p style={{ margin: '4px 0 0', fontSize: 13, fontWeight: 600, color: 'var(--ink)', fontFamily: 'JetBrains Mono, monospace' }}>OpenAPI spec</p>
          <p style={{ margin: '2px 0 0', fontSize: 11, color: 'var(--muted)', fontFamily: 'JetBrains Mono, monospace' }}>+ floom.yaml</p>
        </div>

        <Arrow />

        {/* Floom core */}
        <div style={{
          background: 'var(--accent)',
          borderRadius: 8,
          padding: '10px 20px',
          textAlign: 'center',
          flexShrink: 0,
        }}>
          <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: '#fff', letterSpacing: '-0.02em' }}>Floom</p>
          <p style={{ margin: '2px 0 0', fontSize: 10, color: 'rgba(255,255,255,0.7)' }}>runtime</p>
        </div>

        <Arrow />

        {/* Outputs */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
          {[
            { label: 'MCP server', mono: true },
            { label: 'CLI', mono: true },
            { label: 'HTTP API', mono: true },
            { label: 'Web', mono: false },
          ].map(({ label, mono }) => (
            <div key={label} style={{
              background: 'var(--bg)',
              border: '1px solid var(--line)',
              borderRadius: 6,
              padding: '5px 12px',
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--ink)',
              fontFamily: mono ? 'JetBrains Mono, monospace' : 'inherit',
              whiteSpace: 'nowrap',
            }}>
              {label}
            </div>
          ))}
        </div>

        <Arrow />

        {/* Plumbing */}
        <div style={{
          background: 'var(--bg)',
          border: '1px solid var(--line)',
          borderRadius: 8,
          padding: '10px 16px',
          flexShrink: 0,
        }}>
          <p style={{ margin: '0 0 6px', fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Plumbing</p>
          {['App creator secrets vault', 'Rate limits', 'Streaming', 'Run history'].map((item) => (
            <p key={item} style={{ margin: '2px 0', fontSize: 11, color: 'var(--muted)' }}>{item}</p>
          ))}
        </div>
      </div>
    </div>
  );
}

function Arrow() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', padding: '0 8px', color: 'var(--muted)', flexShrink: 0 }}>
      <svg width={20} height={12} viewBox="0 0 20 12" fill="none">
        <line x1="0" y1="6" x2="14" y2="6" stroke="currentColor" strokeWidth="1.5" />
        <path d="M10 2 L16 6 L10 10" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

// ── ProxiedVsHosted ────────────────────────────────────────────────────────

const PROXIED_YAML = `name: stripe
type: proxied
openapi_spec_url: https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json
base_url: https://api.stripe.com
auth: bearer
secrets: [STRIPE_SECRET_KEY]`;

const HOSTED_YAML = `name: my-app
type: hosted
runtime: python3.12
openapi_spec: ./openapi.yaml
build: pip install .
run: uvicorn my_app.server:app --port 8000`;

const EXAMPLE_MANIFEST_LINKS = [
  'blast-radius',
  'claude-wrapped',
  'dep-check',
  'openpaper',
  'hook-stats',
  'session-recall',
] as const;

function ProxiedVsHosted() {
  const [copiedLeft, setCopiedLeft] = React.useState(false);
  const [copiedRight, setCopiedRight] = React.useState(false);

  const copy = (text: string, setter: (v: boolean) => void) => {
    try { navigator.clipboard.writeText(text).catch(() => {}); } catch { /* ignore */ }
    setter(true);
    setTimeout(() => setter(false), 2000);
  };

  return (
    <div style={{ marginBottom: 36 }}>
      <p style={{ margin: '0 0 12px', fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
        Two deployment modes
      </p>
      <div className="protocol-comparison-2col">
        {/* Proxied */}
        <div style={{
          background: 'var(--card)',
          border: '1px solid var(--line)',
          borderRadius: 10,
          overflow: 'hidden',
        }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>Proxied mode</span>
              <p style={{ margin: '2px 0 0', fontSize: 11, color: 'var(--muted)' }}>Wrap any existing API</p>
            </div>
            <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', background: 'var(--accent-soft)', color: 'var(--accent-hover)', border: '1px solid var(--accent-border)', borderRadius: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Live</span>
          </div>
          <div style={{ position: 'relative' }}>
            <pre style={{
              background: 'var(--bg)',
              color: 'var(--ink)',
              border: '1px solid var(--line)',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 11.5,
              padding: '16px',
              margin: 0,
              lineHeight: 1.8,
              overflowX: 'auto',
              maxWidth: '100%',
              boxSizing: 'border-box',
            }}>
              {PROXIED_YAML}
            </pre>
            <button
              type="button"
              onClick={() => copy(PROXIED_YAML, setCopiedLeft)}
              style={{
                position: 'absolute', top: 8, right: 8,
                fontSize: 10, padding: '2px 8px',
                background: 'var(--card)',
                border: '1px solid var(--line)',
                borderRadius: 4,
                color: copiedLeft ? 'var(--accent)' : 'var(--muted)',
                cursor: 'pointer', fontFamily: 'inherit', transition: 'color 0.15s',
              }}
            >
              {copiedLeft ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>

        {/* Hosted */}
        <div style={{
          background: 'var(--card)',
          border: '1px solid var(--line)',
          borderRadius: 10,
          overflow: 'hidden',
        }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>Hosted mode</span>
              <p style={{ margin: '2px 0 0', fontSize: 11, color: 'var(--muted)' }}>Floom builds and runs your app</p>
            </div>
            <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', background: 'var(--accent-soft)', color: 'var(--accent-hover)', border: '1px solid var(--accent-border)', borderRadius: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Live</span>
          </div>
          <div style={{ position: 'relative' }}>
            <pre style={{
              background: 'var(--bg)',
              color: 'var(--ink)',
              border: '1px solid var(--line)',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 11.5,
              padding: '16px',
              margin: 0,
              lineHeight: 1.8,
              overflowX: 'auto',
              maxWidth: '100%',
              boxSizing: 'border-box',
            }}>
              {HOSTED_YAML}
            </pre>
            <button
              type="button"
              onClick={() => copy(HOSTED_YAML, setCopiedRight)}
              style={{
                position: 'absolute', top: 8, right: 8,
                fontSize: 10, padding: '2px 8px',
                background: 'var(--card)',
                border: '1px solid var(--line)',
                borderRadius: 4,
                color: copiedRight ? 'var(--accent)' : 'var(--muted)',
                cursor: 'pointer', fontFamily: 'inherit', transition: 'color 0.15s',
              }}
            >
              {copiedRight ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Markdown component overrides ───────────────────────────────────────────
// These replace the previous `dangerouslySetInnerHTML` renderer with
// react-markdown's React node tree. Styles mirror the old visual layer
// 1:1 so the page looks identical.

const mdHeadingStyle = (level: number): React.CSSProperties => {
  const sizes: Record<number, number> = { 1: 32, 2: 22, 3: 16 };
  const isDisplay = level <= 2;
  return {
    fontFamily: isDisplay ? 'var(--font-display)' : undefined,
    fontSize: sizes[level] ?? 18,
    fontWeight: 700,
    letterSpacing: isDisplay ? '-0.02em' : undefined,
    color: 'var(--ink)',
    margin: `${level === 1 ? '0 0 16px' : '32px 0 12px'}`,
    lineHeight: 1.25,
    scrollMarginTop: 72,
  };
};

const markdownComponents = {
  h1: ({ children }: { children?: React.ReactNode }) => {
    const text = childrenToText(children);
    return <h1 id={slugify(text.replace(/`/g, ''))} style={mdHeadingStyle(1)}>{children}</h1>;
  },
  h2: ({ children }: { children?: React.ReactNode }) => {
    const text = childrenToText(children);
    return <h2 id={slugify(text.replace(/`/g, ''))} style={mdHeadingStyle(2)}>{children}</h2>;
  },
  h3: ({ children }: { children?: React.ReactNode }) => {
    const text = childrenToText(children);
    return <h3 id={slugify(text.replace(/`/g, ''))} style={mdHeadingStyle(3)}>{children}</h3>;
  },
  p: ({ children }: { children?: React.ReactNode }) => (
    <p style={{ fontSize: 15, lineHeight: 1.7, color: 'var(--ink)', margin: '12px 0' }}>
      {children}
    </p>
  ),
  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul style={{ margin: '10px 0', paddingLeft: 22 }}>{children}</ul>
  ),
  ol: ({ children }: { children?: React.ReactNode }) => (
    <ol style={{ margin: '10px 0', paddingLeft: 22 }}>{children}</ol>
  ),
  li: ({ children }: { children?: React.ReactNode }) => (
    <li style={{ fontSize: 14, lineHeight: 1.7, color: 'var(--ink)', marginBottom: 4 }}>
      {children}
    </li>
  ),
  hr: () => (
    <hr style={{ border: 'none', borderTop: '1px solid var(--line)', margin: '28px 0' }} />
  ),
  strong: ({ children }: { children?: React.ReactNode }) => <strong>{children}</strong>,
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
    href && href.startsWith('/') ? (
      <Link to={href} style={{ color: 'var(--accent)', textDecoration: 'underline' }}>
        {children}
      </Link>
    ) : (
      <a
        href={href}
        target={href && href.startsWith('#') ? undefined : '_blank'}
        rel={href && href.startsWith('#') ? undefined : 'noreferrer'}
        style={{ color: 'var(--accent)', textDecoration: 'underline' }}
      >
        {children}
      </a>
    )
  ),
  // Inline code + code blocks. react-markdown passes `inline=false` on
  // block code and `inline=true` (or omitted) on backtick inline code.
  code: ({ inline, className, children }: {
    inline?: boolean;
    className?: string;
    children?: React.ReactNode;
  }) => {
    const raw = childrenToText(children).replace(/\n$/, '');
    if (inline) {
      return (
        <code
          style={{
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: '0.88em',
            background: 'var(--bg)',
            border: '1px solid var(--line)',
            padding: '2px 6px',
            borderRadius: 4,
          }}
        >
          {children}
        </code>
      );
    }
    return (
      <div style={{ position: 'relative', margin: '16px 0', minWidth: 0, maxWidth: '100%' }}>
        <pre
          style={{
            background: 'var(--bg)',
            color: 'var(--ink)',
            border: '1px solid var(--line)',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 12,
            padding: '20px 16px',
            borderRadius: 10,
            overflowX: 'auto',
            lineHeight: 1.6,
            margin: 0,
            whiteSpace: 'pre',
            maxWidth: '100%',
            boxSizing: 'border-box',
          }}
        >
          <code className={className}>{raw}</code>
        </pre>
        <CopyCodeButton code={raw} />
      </div>
    );
  },
  // Wrap bare <pre> (language-less fenced blocks) so the custom `code`
  // renderer above still runs. react-markdown nests `code` inside `pre`
  // for fenced blocks; we return the code renderer's output directly
  // (it already emits its own <pre>).
  pre: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
};

// ── ProtocolPage ───────────────────────────────────────────────────────────

export function ProtocolPage() {
  const toc = useRef<TocItem[]>(extractToc(protocolMd));
  const [tocOpen, setTocOpen] = useState(false);

  return (
    <div className="page-root" data-testid="protocol-page">
      <PageHead
        title="The Floom Protocol · Floom"
        description="How Floom turns one OpenAPI spec into an MCP server, a web UI, an HTTP API, and typed client SDKs, with app creator secrets, rate limits, and audit logs wired in."
      />
      <TopBar />

      <main
        style={{
          maxWidth: 1080,
          margin: '0 auto',
          padding: '48px 24px 80px',
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 220px) minmax(0, 1fr)',
          gap: 48,
          alignItems: 'start',
          minWidth: 0,
        }}
      >
        {/* Left: Table of Contents (desktop) */}
        <aside
          style={{
            position: 'sticky',
            top: 72,
            display: 'block',
          }}
          className="protocol-toc"
        >
          <p
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: 'var(--muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              marginBottom: 12,
            }}
          >
            Contents
          </p>
          <nav>
            {toc.current.map((item) => (
              <a
                key={item.id}
                href={`#${item.id}`}
                style={{
                  display: 'block',
                  fontSize: 13,
                  color: 'var(--muted)',
                  textDecoration: 'none',
                  padding: '4px 0',
                  paddingLeft: item.level === 1 ? 0 : item.level === 2 ? 0 : 12,
                  fontWeight: item.level === 1 ? 600 : 400,
                  transition: 'color 0.1s',
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLAnchorElement).style.color = 'var(--ink)';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLAnchorElement).style.color = 'var(--muted)';
                }}
              >
                {item.text}
              </a>
            ))}
          </nav>
        </aside>

        {/* Right: Content */}
        <article>
          {/* Mobile TOC toggle */}
          <button
            type="button"
            className="protocol-toc-toggle"
            onClick={() => setTocOpen((v) => !v)}
            style={{
              display: 'none',
              marginBottom: 20,
              padding: '8px 14px',
              background: 'var(--card)',
              border: '1px solid var(--line)',
              borderRadius: 8,
              fontSize: 13,
              cursor: 'pointer',
              fontFamily: 'inherit',
              color: 'var(--ink)',
            }}
          >
            {tocOpen ? 'Hide contents' : 'Show contents'}
          </button>

          {tocOpen && (
            <div
              style={{
                display: 'none',
                background: 'var(--card)',
                border: '1px solid var(--line)',
                borderRadius: 10,
                padding: '16px 20px',
                marginBottom: 24,
              }}
              className="protocol-toc-mobile"
            >
              {toc.current.map((item) => (
                <a
                  key={item.id}
                  href={`#${item.id}`}
                  onClick={() => setTocOpen(false)}
                  style={{
                    display: 'block',
                    fontSize: 13,
                    color: 'var(--muted)',
                    textDecoration: 'none',
                    padding: '4px 0',
                    paddingLeft: item.level === 3 ? 12 : 0,
                    fontWeight: item.level === 1 ? 600 : 400,
                  }}
                >
                  {item.text}
                </a>
              ))}
            </div>
          )}

          {/* Flow diagram */}
          <FlowDiagram />

          {/* Proxied vs Hosted side-by-side */}
          <ProxiedVsHosted />

          {/* Rendered markdown — no more dangerouslySetInnerHTML. */}
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={markdownComponents as never}
          >
            {protocolMd}
          </ReactMarkdown>

          {/* Footer links */}
          <div
            style={{
              marginTop: 48,
              padding: '24px',
              background: 'var(--card)',
              border: '1px solid var(--line)',
              borderRadius: 12,
              display: 'flex',
              flexWrap: 'wrap',
              gap: 12,
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <div>
              <p style={{ margin: '0 0 4px', fontSize: 14, fontWeight: 600 }}>
                The protocol is open.
              </p>
              <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>
                Self-host, fork, or contribute. Runtime and docs live in the main repo.
              </p>
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <a
                href="https://github.com/floomhq/floom"
                target="_blank"
                rel="noreferrer"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '8px 16px',
                  background: 'var(--ink)',
                  color: '#fff',
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 600,
                  textDecoration: 'none',
                }}
              >
                <svg width={13} height={13} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <use href="#icon-github" />
                </svg>
                View on GitHub
              </a>
              <Link
                to="/apps"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  padding: '8px 16px',
                  background: 'var(--card)',
                  border: '1px solid var(--line)',
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 500,
                  textDecoration: 'none',
                  color: 'var(--ink)',
                }}
              >
                Browse apps
              </Link>
            </div>
          </div>

          <div style={{ marginTop: 24 }}>
            <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 10 }}>
              Quick answers
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {[
                { label: 'Runtime & limits', to: '/docs/limits' },
                { label: 'Security', to: '/docs/security' },
                { label: 'Observability', to: '/docs/observability' },
                { label: 'Workflow', to: '/docs/workflow' },
                { label: 'Ownership', to: '/docs/ownership' },
                { label: 'Reliability', to: '/docs/reliability' },
                { label: 'Pricing', to: '/docs/pricing' },
              ].map((item) => (
                <Link
                  key={item.to}
                  to={item.to}
                  style={{
                    fontSize: 12,
                    color: 'var(--accent)',
                    textDecoration: 'none',
                    padding: '4px 10px',
                    border: '1px solid var(--line)',
                    borderRadius: 6,
                    background: 'var(--bg)',
                  }}
                >
                  {item.label}
                </Link>
              ))}
            </div>
          </div>

          {/* Example manifests */}
          <div style={{ marginTop: 32 }}>
            <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 10 }}>
              Example manifests
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {EXAMPLE_MANIFEST_LINKS.map((slug) => (
                <a
                  key={slug}
                  href={`https://github.com/floomhq/floom/blob/main/examples/${slug}/floom.yaml`}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    fontSize: 12,
                    fontFamily: 'JetBrains Mono, monospace',
                    color: 'var(--accent)',
                    textDecoration: 'none',
                    padding: '4px 10px',
                    border: '1px solid var(--line)',
                    borderRadius: 6,
                    background: 'var(--bg)',
                  }}
                >
                  {slug}/floom.yaml
                </a>
              ))}
            </div>
          </div>

          {/* Self-host one-liner */}
          <div
            style={{
              marginTop: 32,
              padding: '16px 20px',
              background: 'var(--bg)',
              color: 'var(--ink)',
              border: '1px solid var(--line)',
              borderRadius: 10,
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 12,
              lineHeight: 1.8,
            }}
          >
            <span style={{ color: 'var(--muted)' }}># Self-host Floom</span>
            {'\n'}
            <span style={{ color: 'var(--muted)' }}>$</span> docker run -p 3000:3000 ghcr.io/floomhq/floom-monorepo:latest
          </div>
        </article>
      </main>
      <Footer />
      <FeedbackButton />
    </div>
  );
}
