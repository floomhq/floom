import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { Link, useParams, useLocation, useNavigate } from 'react-router-dom';
import { TopBar } from '../components/TopBar';
import { Footer } from '../components/Footer';
import { FeedbackButton } from '../components/FeedbackButton';
import { parseMd, extractToc, inlineHtml } from '../lib/markdown';
import type { Block } from '../lib/markdown';

// Each docs section is a raw-imported Markdown file. vite-plugin-react's
// `?raw` suffix turns the file into a string at build time — no runtime
// network call, no separate deploy artifact.
import gettingStartedMd from '../docs/getting-started.md?raw';
import protocolMd from '../docs/protocol.md?raw';
import selfHostingMd from '../docs/self-hosting.md?raw';
import apiMd from '../docs/api.md?raw';
import guidesMd from '../docs/guides.md?raw';
import rateLimitsMd from '../docs/rate-limits.md?raw';
import legalMd from '../docs/legal.md?raw';
import changelogMd from '../docs/changelog.md?raw';

// ── Section registry ─────────────────────────────────────────────────

interface Section {
  slug: string;
  title: string;
  body: string;
  file: string; // for "Edit on GitHub" link
  hasApi?: boolean; // toggles the right-rail code samples panel
}

const SECTIONS: Section[] = [
  { slug: 'getting-started', title: 'Getting started', body: gettingStartedMd, file: 'apps/web/src/docs/getting-started.md' },
  { slug: 'protocol',        title: 'Protocol',        body: protocolMd,       file: 'apps/web/src/docs/protocol.md' },
  { slug: 'self-hosting',    title: 'Self-hosting',    body: selfHostingMd,    file: 'apps/web/src/docs/self-hosting.md' },
  { slug: 'api',             title: 'API reference',   body: apiMd,            file: 'apps/web/src/docs/api.md', hasApi: true },
  { slug: 'guides',          title: 'Build guides',    body: guidesMd,         file: 'apps/web/src/docs/guides.md' },
  { slug: 'rate-limits',     title: 'Rate limits',     body: rateLimitsMd,     file: 'apps/web/src/docs/rate-limits.md', hasApi: true },
  { slug: 'legal',           title: 'Legal',           body: legalMd,          file: 'apps/web/src/docs/legal.md' },
  { slug: 'changelog',       title: 'Changelog',       body: changelogMd,      file: 'apps/web/src/docs/changelog.md' },
];

const GITHUB_BASE = 'https://github.com/floomhq/floom/blob/main/';

// ── Right-rail code samples (only shown on /docs/api and /docs/rate-limits) ─

type Lang = 'curl' | 'python' | 'js' | 'mcp';

const LANG_LABEL: Record<Lang, string> = { curl: 'cURL', python: 'Python', js: 'JS', mcp: 'MCP' };

interface CodeSample {
  curl: string;
  python: string;
  js: string;
  mcp: string;
}

const RUN_SAMPLE: CodeSample = {
  curl: `curl -sX POST http://localhost:3051/api/petstore/run \\
  -H 'content-type: application/json' \\
  -d '{
    "action": "listPets",
    "inputs": { "limit": 3 }
  }'`,
  python: `import httpx

resp = httpx.post(
    "http://localhost:3051/api/petstore/run",
    json={"action": "listPets", "inputs": {"limit": 3}},
    timeout=60,
)
print(resp.json())`,
  js: `const res = await fetch('http://localhost:3051/api/petstore/run', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    action: 'listPets',
    inputs: { limit: 3 },
  }),
});
console.log(await res.json());`,
  mcp: `curl -sX POST http://localhost:3051/mcp/app/petstore \\
  -H 'content-type: application/json' \\
  -H 'accept: application/json, text/event-stream' \\
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "listPets",
      "arguments": { "limit": 3 }
    }
  }'`,
};

function CodeSamples({ sample }: { sample: CodeSample }) {
  const [lang, setLang] = useState<Lang>('curl');
  const [copied, setCopied] = useState(false);
  const code = sample[lang];

  const onCopy = () => {
    try { navigator.clipboard.writeText(code).catch(() => {}); } catch { /* ignore */ }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const tabStyle = (active: boolean): CSSProperties => ({
    padding: '6px 11px',
    borderRadius: 6,
    fontSize: 11.5,
    fontWeight: 500,
    fontFamily: 'JetBrains Mono, monospace',
    cursor: 'pointer',
    color: active ? 'var(--ink)' : 'var(--muted)',
    background: active ? '#fff' : 'transparent',
    border: active ? '1px solid var(--line)' : '1px solid transparent',
    boxShadow: active ? '0 1px 2px rgba(0,0,0,0.04)' : 'none',
    transition: 'all 0.1s',
  });

  return (
    <div>
      <p style={{ margin: '0 0 10px', fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
        Sample · run an operation
      </p>
      <div style={{ display: 'flex', gap: 4, padding: 4, borderRadius: 8, background: 'var(--bg)', marginBottom: 10 }}>
        {(['curl', 'python', 'js', 'mcp'] as Lang[]).map((l) => (
          <button key={l} type="button" onClick={() => setLang(l)} style={tabStyle(l === lang)}>
            {LANG_LABEL[l]}
          </button>
        ))}
      </div>
      <div style={{ position: 'relative', minWidth: 0, maxWidth: '100%' }}>
        <pre style={{
          background: 'var(--terminal-bg, #0e0e0c)',
          color: 'var(--terminal-ink, #d4d4c8)',
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 11.5,
          padding: '14px 14px',
          borderRadius: 8,
          margin: 0,
          lineHeight: 1.65,
          overflowX: 'auto',
          whiteSpace: 'pre',
          maxWidth: '100%',
          boxSizing: 'border-box',
        }}>{code}</pre>
        <button
          type="button"
          onClick={onCopy}
          style={{
            position: 'absolute', top: 8, right: 8,
            fontSize: 10, padding: '3px 8px',
            background: 'rgba(255,255,255,0.08)',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 4,
            color: copied ? '#7bffc0' : 'rgba(255,255,255,0.55)',
            cursor: 'pointer', fontFamily: 'inherit',
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

// ── Block renderer ───────────────────────────────────────────────────

function BlockView({ block }: { block: Block }) {
  if (block.type === 'hr') {
    return <hr style={{ border: 'none', borderTop: '1px solid var(--line)', margin: '28px 0' }} />;
  }

  if (block.type === 'heading') {
    const Tag = `h${block.level}` as 'h1' | 'h2' | 'h3';
    const sizes: Record<number, number> = { 1: 32, 2: 22, 3: 16 };
    return (
      <Tag
        id={block.id}
        style={{
          fontSize: sizes[block.level],
          fontWeight: 700,
          color: 'var(--ink)',
          margin: block.level === 1 ? '0 0 16px' : '32px 0 12px',
          lineHeight: 1.25,
          scrollMarginTop: 80,
        }}
        dangerouslySetInnerHTML={{ __html: inlineHtml(block.text) }}
      />
    );
  }

  if (block.type === 'code') {
    return <CodeBlock code={block.code} />;
  }

  if (block.type === 'paragraph') {
    return (
      <p
        style={{ fontSize: 15, lineHeight: 1.7, color: 'var(--ink)', margin: '12px 0' }}
        dangerouslySetInnerHTML={{ __html: inlineHtml(block.text) }}
      />
    );
  }

  if (block.type === 'ul') {
    return (
      <ul style={{ margin: '10px 0', paddingLeft: 22 }}>
        {block.items.map((item, idx) => (
          <li
            key={idx}
            style={{ fontSize: 14, lineHeight: 1.7, color: 'var(--ink)', marginBottom: 4 }}
            dangerouslySetInnerHTML={{ __html: inlineHtml(item) }}
          />
        ))}
      </ul>
    );
  }

  if (block.type === 'ol') {
    return (
      <ol style={{ margin: '10px 0', paddingLeft: 22 }}>
        {block.items.map((item, idx) => (
          <li
            key={idx}
            style={{ fontSize: 14, lineHeight: 1.7, color: 'var(--ink)', marginBottom: 4 }}
            dangerouslySetInnerHTML={{ __html: inlineHtml(item) }}
          />
        ))}
      </ol>
    );
  }

  if (block.type === 'table') {
    return (
      <div style={{ overflowX: 'auto', margin: '16px 0' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13.5 }}>
          <thead>
            <tr>
              {block.headers.map((h, i) => (
                <th
                  key={i}
                  style={{
                    textAlign: 'left',
                    padding: '10px 14px',
                    borderBottom: '1px solid var(--line)',
                    fontWeight: 700,
                    color: 'var(--ink)',
                    background: 'var(--bg)',
                  }}
                  dangerouslySetInnerHTML={{ __html: inlineHtml(h) }}
                />
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, ri) => (
              <tr key={ri}>
                {row.map((cell, ci) => (
                  <td
                    key={ci}
                    style={{
                      padding: '10px 14px',
                      borderBottom: '1px solid var(--line)',
                      color: 'var(--ink)',
                      verticalAlign: 'top',
                      lineHeight: 1.6,
                    }}
                    dangerouslySetInnerHTML={{ __html: inlineHtml(cell) }}
                  />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return null;
}

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = () => {
    try { navigator.clipboard.writeText(code).catch(() => {}); } catch { /* ignore */ }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div style={{ position: 'relative', margin: '16px 0' }}>
      <pre
        style={{
          background: 'var(--terminal-bg, #0e0e0c)',
          color: 'var(--terminal-ink, #d4d4c8)',
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
        {code}
      </pre>
      <button
        type="button"
        onClick={onCopy}
        style={{
          position: 'absolute', top: 10, right: 10,
          fontSize: 11, padding: '3px 10px',
          background: 'rgba(255,255,255,0.1)',
          border: '1px solid rgba(255,255,255,0.15)',
          borderRadius: 6,
          color: copied ? '#7bffc0' : 'rgba(255,255,255,0.6)',
          cursor: 'pointer', fontFamily: 'inherit',
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

// ── Search modal (stub) ──────────────────────────────────────────────

function SearchModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(14,14,12,0.38)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        paddingTop: '18vh', zIndex: 100,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--card)',
          border: '1px solid var(--line)',
          borderRadius: 14,
          width: 'min(560px, 90vw)',
          padding: 22,
          boxShadow: '0 30px 80px -20px rgba(15,23,42,0.24)',
        }}
      >
        <input
          autoFocus
          placeholder="Search docs..."
          style={{
            width: '100%', padding: '10px 12px',
            border: '1px solid var(--line)', borderRadius: 8,
            fontSize: 14, outline: 'none', background: 'var(--bg)', color: 'var(--ink)',
          }}
        />
        <p style={{ margin: '14px 2px 0', fontSize: 12.5, color: 'var(--muted)' }}>
          Full-text search is coming soon. For now, use the left-nav tree or Ctrl/Cmd+F within a page.
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: '6px 12px', fontSize: 12, fontWeight: 500,
              background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: 6,
              cursor: 'pointer', color: 'var(--ink)', fontFamily: 'inherit',
            }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// ── DocsPage ─────────────────────────────────────────────────────────

export function DocsPage() {
  const { slug } = useParams<{ slug?: string }>();
  const location = useLocation();
  const navigate = useNavigate();

  const activeSlug = (slug ?? 'getting-started').toLowerCase();
  const active = SECTIONS.find((s) => s.slug === activeSlug) ?? SECTIONS[0];

  const blocks = useMemo(() => parseMd(active.body), [active.body]);
  const toc = useMemo(() => extractToc(active.body).filter((i) => i.level === 2 || i.level === 3), [active.body]);

  // Redirect unknown slugs to getting-started without hammering history.
  useEffect(() => {
    if (slug && !SECTIONS.some((s) => s.slug === slug)) {
      navigate('/docs/getting-started', { replace: true });
    }
  }, [slug, navigate]);

  // Update title per section.
  useEffect(() => {
    document.title = `${active.title} — Floom docs`;
    return () => { document.title = 'Floom: production layer for AI apps'; };
  }, [active.title]);

  // Scroll to anchor when hash changes.
  useEffect(() => {
    if (!location.hash) {
      window.scrollTo({ top: 0 });
      return;
    }
    const id = location.hash.slice(1);
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [location.hash, active.slug]);

  // cmd-K search modal.
  const [searchOpen, setSearchOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
      if (e.key === 'Escape') setSearchOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Mobile drawer.
  const [navOpen, setNavOpen] = useState(false);

  // Prev / next pager.
  const activeIdx = SECTIONS.findIndex((s) => s.slug === active.slug);
  const prev = activeIdx > 0 ? SECTIONS[activeIdx - 1] : null;
  const next = activeIdx < SECTIONS.length - 1 ? SECTIONS[activeIdx + 1] : null;

  return (
    <div className="page-root docs-page" data-testid="docs-page">
      <TopBar />

      {/* Sub-header with search */}
      <div className="docs-subheader" style={{
        position: 'sticky', top: 56, zIndex: 20,
        background: 'var(--card)',
        borderBottom: '1px solid var(--line)',
        padding: '10px 20px',
      }}>
        <div style={{ maxWidth: 1400, margin: '0 auto', display: 'flex', alignItems: 'center', gap: 16 }}>
          <button
            type="button"
            className="docs-nav-toggle"
            onClick={() => setNavOpen((v) => !v)}
            style={{
              display: 'none', padding: 8, background: 'transparent',
              border: '1px solid var(--line)', borderRadius: 6, cursor: 'pointer',
              fontFamily: 'inherit', color: 'var(--ink)',
            }}
            aria-label="Toggle navigation"
          >
            ≡
          </button>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>Docs</span>
          <span style={{ fontSize: 11.5, fontFamily: 'JetBrains Mono, monospace', color: 'var(--muted)', padding: '3px 9px', border: '1px solid var(--line)', borderRadius: 999 }}>v0.4</span>
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            style={{
              flex: 1, maxWidth: 440, padding: '7px 36px 7px 34px',
              background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: 8,
              fontSize: 12.5, color: 'var(--muted)', cursor: 'pointer', textAlign: 'left',
              position: 'relative', fontFamily: 'inherit',
            }}
          >
            <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ position: 'absolute', left: 10, top: 9 }}>
              <circle cx="11" cy="11" r="8" />
              <path d="M21 21l-4.35-4.35" strokeLinecap="round" />
            </svg>
            Search docs
            <span style={{ position: 'absolute', right: 8, top: 6, fontSize: 10.5, fontFamily: 'JetBrains Mono, monospace', background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 4, padding: '2px 7px', color: 'var(--muted)' }}>⌘K</span>
          </button>
        </div>
      </div>

      {/* 3-column grid */}
      <main
        className="docs-grid"
        style={{
          maxWidth: 1400,
          margin: '0 auto',
          padding: '0 20px 60px',
          display: 'grid',
          gridTemplateColumns: '220px minmax(0, 1fr) 300px',
          gap: 36,
          alignItems: 'start',
        }}
      >
        {/* Left nav */}
        <aside
          className={`docs-nav ${navOpen ? 'docs-nav-open' : ''}`}
          style={{ position: 'sticky', top: 112, paddingTop: 28 }}
        >
          <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 10px 6px' }}>
            Contents
          </p>
          <nav style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {SECTIONS.map((s) => (
              <Link
                key={s.slug}
                to={`/docs/${s.slug}`}
                onClick={() => setNavOpen(false)}
                style={{
                  display: 'block',
                  padding: '7px 10px',
                  borderRadius: 6,
                  fontSize: 13,
                  fontWeight: s.slug === active.slug ? 600 : 500,
                  color: s.slug === active.slug ? 'var(--accent, #059669)' : 'var(--ink)',
                  background: s.slug === active.slug ? 'rgba(5, 150, 105, 0.08)' : 'transparent',
                  textDecoration: 'none',
                }}
              >
                {s.title}
              </Link>
            ))}
          </nav>

          {/* Section TOC below */}
          {toc.length > 0 && (
            <>
              <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '26px 0 10px 6px' }}>
                On this page
              </p>
              <nav style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                {toc.map((item) => (
                  <a
                    key={item.id}
                    href={`#${item.id}`}
                    style={{
                      display: 'block',
                      padding: '4px 10px',
                      paddingLeft: item.level === 3 ? 22 : 10,
                      fontSize: 12.5,
                      color: 'var(--muted)',
                      textDecoration: 'none',
                      borderLeft: '2px solid transparent',
                    }}
                  >
                    {item.text}
                  </a>
                ))}
              </nav>
            </>
          )}
        </aside>

        {/* Center content */}
        <article className="docs-content" style={{ paddingTop: 28, minWidth: 0 }}>
          {/* Breadcrumb */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontFamily: 'JetBrains Mono, monospace', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
            <Link to="/docs" style={{ color: 'var(--muted)', textDecoration: 'none' }}>DOCS</Link>
            <span>›</span>
            <span style={{ color: 'var(--accent, #059669)' }}>{active.title.toUpperCase()}</span>
          </div>

          {/* Rendered markdown */}
          {blocks.map((block, idx) => <BlockView key={idx} block={block} />)}

          {/* Edit on GitHub + last updated row */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            marginTop: 40, paddingTop: 20, borderTop: '1px solid var(--line)',
            fontSize: 12, color: 'var(--muted)',
          }}>
            <a
              href={`${GITHUB_BASE}${active.file}`}
              target="_blank"
              rel="noreferrer"
              style={{ color: 'var(--muted)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              <svg width={12} height={12} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <use href="#icon-github" />
              </svg>
              Edit on GitHub
            </a>
            <span>Last updated 2026-04-17</span>
          </div>

          {/* Prev / next pager */}
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 16,
          }}>
            {prev ? (
              <Link
                to={`/docs/${prev.slug}`}
                style={{
                  padding: '14px 16px', background: 'var(--card)',
                  border: '1px solid var(--line)', borderRadius: 10,
                  textDecoration: 'none', color: 'inherit', display: 'block',
                }}
              >
                <span style={{ display: 'block', fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>← Previous</span>
                <span style={{ display: 'block', fontSize: 13.5, fontWeight: 600, color: 'var(--ink)' }}>{prev.title}</span>
              </Link>
            ) : <span />}
            {next ? (
              <Link
                to={`/docs/${next.slug}`}
                style={{
                  padding: '14px 16px', background: 'var(--card)',
                  border: '1px solid var(--line)', borderRadius: 10,
                  textDecoration: 'none', color: 'inherit', display: 'block',
                  textAlign: 'right',
                }}
              >
                <span style={{ display: 'block', fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Next →</span>
                <span style={{ display: 'block', fontSize: 13.5, fontWeight: 600, color: 'var(--ink)' }}>{next.title}</span>
              </Link>
            ) : <span />}
          </div>
        </article>

        {/* Right rail */}
        <aside className="docs-rail" style={{ position: 'sticky', top: 112, paddingTop: 28, minWidth: 0, maxWidth: '100%', width: '100%', overflow: 'hidden' }}>
          {active.hasApi ? (
            <CodeSamples sample={RUN_SAMPLE} />
          ) : (
            <div style={{
              padding: 16, background: 'var(--card)', border: '1px solid var(--line)',
              borderRadius: 10, fontSize: 13, lineHeight: 1.55, color: 'var(--ink)',
            }}>
              <p style={{ margin: '0 0 6px', fontWeight: 700, fontSize: 12.5 }}>Self-host Floom</p>
              <p style={{ margin: '0 0 12px', fontSize: 12.5, color: 'var(--muted)' }}>
                One Docker command boots the full runtime: web form, MCP, HTTP, CLI.
              </p>
              <pre style={{
                background: 'var(--terminal-bg, #0e0e0c)',
                color: 'var(--terminal-ink, #d4d4c8)',
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 10.5,
                padding: '10px 12px',
                borderRadius: 6,
                margin: 0,
                lineHeight: 1.55,
                overflowX: 'auto',
              }}>docker run -p 3051:3051 \{'\n'}  ghcr.io/floomhq/floom-monorepo:{'\n'}  v0.4.0-mvp.4</pre>
              <Link
                to="/docs/self-hosting"
                style={{ display: 'inline-block', marginTop: 10, fontSize: 12.5, color: 'var(--accent, #059669)', textDecoration: 'none', fontWeight: 600 }}
              >
                Full self-host guide →
              </Link>
            </div>
          )}

          <div style={{ marginTop: 16, padding: 14, background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: 10, fontSize: 12.5, color: 'var(--muted)' }}>
            Have a question we didn't answer? Open an issue on{' '}
            <a href="https://github.com/floomhq/floom/issues" target="_blank" rel="noreferrer" style={{ color: 'var(--accent, #059669)', textDecoration: 'none' }}>
              GitHub
            </a>{' '}
            or email <a href="mailto:hello@floom.dev" style={{ color: 'var(--accent, #059669)', textDecoration: 'none' }}>hello@floom.dev</a>.
          </div>
        </aside>
      </main>

      <Footer />
      <FeedbackButton />
      <SearchModal open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}
