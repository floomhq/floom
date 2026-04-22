// /docs/* — launch-week documentation surface.
//
// Four pages, one component. Each page is a markdown file under
// assets/docs/, imported at build time via Vite ?raw, and rendered with
// react-markdown using the same component overrides as /protocol so the
// visual layer stays identical.
//
// Design rules (from #295 + #301):
//   - Light code blocks — bg var(--bg), ink var(--ink), 1px var(--line)
//     border. PDF-printable. No dark terminal chrome on the docs route.
//   - Table of contents in a sticky right rail on desktop, collapsible
//     button on mobile. Same pattern as ProtocolPage.
//   - Docs section nav on the left lists the four pages plus a deep-link
//     to the full spec on /protocol. Active page is highlighted.
//
// Why not MDX or a separate docs app? YAGNI for 4 pages. If we grow past
// that and need per-page React components, a dedicated docs surface
// (apps/docs) is the migration path. For launch, markdown + sidebar
// ships the content without a new build target.
//
// Links between docs pages use relative ./getting-started style in the
// markdown — the renderer rewrites them to /docs/<page> so the SPA
// router handles them without a full page reload.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, Navigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { TopBar } from '../components/TopBar';
import { Footer } from '../components/Footer';
import { FeedbackButton } from '../components/FeedbackButton';

import gettingStartedMd from '../assets/docs/getting-started.md?raw';
import protocolDocMd from '../assets/docs/protocol.md?raw';
import deployMd from '../assets/docs/deploy.md?raw';
import limitsMd from '../assets/docs/limits.md?raw';

// ── Page registry ──────────────────────────────────────────────────────────

type DocsSlug = 'getting-started' | 'protocol' | 'deploy' | 'limits';

const PAGES: Record<DocsSlug, { title: string; md: string }> = {
  'getting-started': { title: 'Getting started', md: gettingStartedMd },
  'protocol': { title: 'Protocol', md: protocolDocMd },
  'deploy': { title: 'Deploy', md: deployMd },
  'limits': { title: 'Limits', md: limitsMd },
};

const NAV_ORDER: DocsSlug[] = ['getting-started', 'protocol', 'deploy', 'limits'];

// ── Helpers (same shape as ProtocolPage) ───────────────────────────────────

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

function childrenToText(children: React.ReactNode): string {
  if (typeof children === 'string') return children;
  if (typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(childrenToText).join('');
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

// ── Markdown renderers (light code blocks, internal link rewriting) ────────

const mdHeadingStyle = (level: number): React.CSSProperties => {
  const sizes: Record<number, number> = { 1: 32, 2: 22, 3: 16 };
  return {
    fontSize: sizes[level] ?? 18,
    fontWeight: 700,
    color: 'var(--ink)',
    margin: `${level === 1 ? '0 0 16px' : '32px 0 12px'}`,
    lineHeight: 1.25,
    scrollMarginTop: 72,
  };
};

const markdownComponents = {
  h1: ({ children }: { children?: React.ReactNode }) => (
    <h1 id={slugify(childrenToText(children).replace(/`/g, ''))} style={mdHeadingStyle(1)}>
      {children}
    </h1>
  ),
  h2: ({ children }: { children?: React.ReactNode }) => (
    <h2 id={slugify(childrenToText(children).replace(/`/g, ''))} style={mdHeadingStyle(2)}>
      {children}
    </h2>
  ),
  h3: ({ children }: { children?: React.ReactNode }) => (
    <h3 id={slugify(childrenToText(children).replace(/`/g, ''))} style={mdHeadingStyle(3)}>
      {children}
    </h3>
  ),
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
  hr: () => <hr style={{ border: 'none', borderTop: '1px solid var(--line)', margin: '28px 0' }} />,
  strong: ({ children }: { children?: React.ReactNode }) => <strong>{children}</strong>,
  table: ({ children }: { children?: React.ReactNode }) => (
    <div style={{ overflowX: 'auto', margin: '16px 0' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>{children}</table>
    </div>
  ),
  th: ({ children }: { children?: React.ReactNode }) => (
    <th
      style={{
        textAlign: 'left',
        padding: '8px 12px',
        borderBottom: '1px solid var(--line)',
        fontWeight: 700,
        color: 'var(--ink)',
      }}
    >
      {children}
    </th>
  ),
  td: ({ children }: { children?: React.ReactNode }) => (
    <td
      style={{
        padding: '8px 12px',
        borderBottom: '1px solid var(--line)',
        color: 'var(--ink)',
        verticalAlign: 'top',
      }}
    >
      {children}
    </td>
  ),
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => {
    // Relative docs link (./getting-started, ./protocol, ...) → SPA link.
    if (href && href.startsWith('./')) {
      const target = href.replace(/^\.\//, '').replace(/[#?].*$/, '');
      return (
        <Link
          to={`/docs/${target}`}
          style={{ color: 'var(--accent)', textDecoration: 'underline' }}
        >
          {children}
        </Link>
      );
    }
    // Absolute-in-site link (/protocol, /apps, ...) → SPA link too.
    if (href && href.startsWith('/')) {
      return (
        <Link to={href} style={{ color: 'var(--accent)', textDecoration: 'underline' }}>
          {children}
        </Link>
      );
    }
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        style={{ color: 'var(--accent)', textDecoration: 'underline' }}
      >
        {children}
      </a>
    );
  },
  code: ({
    inline,
    className,
    children,
  }: {
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
            background: 'var(--card)',
            border: '1px solid var(--line)',
            padding: '2px 6px',
            borderRadius: 4,
            color: 'var(--ink)',
          }}
        >
          {children}
        </code>
      );
    }
    return (
      <div style={{ position: 'relative', margin: '16px 0' }}>
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
          }}
        >
          <code className={className}>{raw}</code>
        </pre>
        <CopyCodeButton code={raw} />
      </div>
    );
  },
  pre: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
};

// ── DocsPage ───────────────────────────────────────────────────────────────

export function DocsPage() {
  const { slug } = useParams<{ slug?: string }>();
  const activeSlug = (slug as DocsSlug | undefined) ?? 'getting-started';

  // Unknown slug → redirect to the index.
  if (slug && !(slug in PAGES)) {
    return <Navigate to="/docs/getting-started" replace />;
  }

  const page = PAGES[activeSlug];
  const toc = useMemo<TocItem[]>(() => extractToc(page.md), [page.md]);
  const [tocOpen, setTocOpen] = useState(false);
  const previousTitle = useRef<string>('');

  useEffect(() => {
    previousTitle.current = document.title;
    document.title = `${page.title} · Floom docs`;
    return () => {
      document.title = previousTitle.current || 'Floom';
    };
  }, [page.title]);

  return (
    <div className="page-root" data-testid="docs-page">
      <TopBar />

      <main
        style={{
          maxWidth: 1200,
          margin: '0 auto',
          padding: '48px 24px 80px',
          display: 'grid',
          gridTemplateColumns: '200px 1fr 220px',
          gap: 32,
          alignItems: 'start',
        }}
        className="docs-layout"
      >
        {/* Left: docs section nav */}
        <aside
          style={{
            position: 'sticky',
            top: 72,
          }}
          className="docs-nav"
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
            Docs
          </p>
          <nav>
            {NAV_ORDER.map((s) => (
              <Link
                key={s}
                to={`/docs/${s}`}
                style={{
                  display: 'block',
                  fontSize: 13,
                  padding: '6px 10px',
                  margin: '2px 0',
                  borderRadius: 6,
                  textDecoration: 'none',
                  color: s === activeSlug ? 'var(--ink)' : 'var(--muted)',
                  background: s === activeSlug ? 'var(--card)' : 'transparent',
                  fontWeight: s === activeSlug ? 600 : 400,
                  border: '1px solid ' + (s === activeSlug ? 'var(--line)' : 'transparent'),
                }}
              >
                {PAGES[s].title}
              </Link>
            ))}
          </nav>
          <div
            style={{
              marginTop: 24,
              paddingTop: 16,
              borderTop: '1px solid var(--line)',
              fontSize: 12,
              color: 'var(--muted)',
              lineHeight: 1.6,
            }}
          >
            <Link to="/protocol" style={{ color: 'var(--accent)', textDecoration: 'none' }}>
              Full spec →
            </Link>
            <br />
            <a
              href="https://github.com/floomhq/floom"
              target="_blank"
              rel="noreferrer"
              style={{ color: 'var(--accent)', textDecoration: 'none' }}
            >
              GitHub →
            </a>
          </div>
        </aside>

        {/* Middle: content */}
        <article style={{ minWidth: 0 }}>
          <button
            type="button"
            className="docs-toc-toggle"
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
                background: 'var(--card)',
                border: '1px solid var(--line)',
                borderRadius: 10,
                padding: '16px 20px',
                marginBottom: 24,
              }}
              className="docs-toc-mobile"
            >
              {toc.map((item) => (
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

          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={markdownComponents as never}
          >
            {page.md}
          </ReactMarkdown>
        </article>

        {/* Right: on-this-page TOC (desktop) */}
        <aside
          style={{
            position: 'sticky',
            top: 72,
          }}
          className="docs-toc"
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
            On this page
          </p>
          <nav>
            {toc.map((item) => (
              <a
                key={item.id}
                href={`#${item.id}`}
                style={{
                  display: 'block',
                  fontSize: 12,
                  color: 'var(--muted)',
                  textDecoration: 'none',
                  padding: '3px 0',
                  paddingLeft: item.level === 1 ? 0 : item.level === 2 ? 0 : 12,
                  fontWeight: item.level === 1 ? 600 : 400,
                  lineHeight: 1.4,
                }}
              >
                {item.text}
              </a>
            ))}
          </nav>
        </aside>
      </main>
      <Footer />
      <FeedbackButton />
    </div>
  );
}
