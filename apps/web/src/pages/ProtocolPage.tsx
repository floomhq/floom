import React, { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { TopBar } from '../components/TopBar';
import { Footer } from '../components/Footer';
import { FeedbackButton } from '../components/FeedbackButton';
// Import the protocol markdown at build time via Vite ?raw
import protocolMd from '../assets/protocol.md?raw';

// ── Minimal Markdown renderer ──────────────────────────────────────────────
// Handles: headings, code blocks (with copy), inline code, bold, paragraphs,
// ordered/unordered lists, horizontal rules. No external deps.

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
        background: 'rgba(255,255,255,0.1)',
        border: '1px solid rgba(255,255,255,0.15)',
        borderRadius: 6,
        color: copied ? '#7bffc0' : 'rgba(255,255,255,0.6)',
        cursor: 'pointer',
        fontFamily: 'inherit',
        transition: 'color 0.15s',
      }}
    >
      {copied ? 'Copied!' : 'Copy'}
    </button>
  );
}

interface RenderedBlock {
  type: 'heading' | 'code' | 'paragraph' | 'ul' | 'ol' | 'hr';
  level?: number;
  id?: string;
  text?: string;
  lang?: string;
  code?: string;
  items?: string[];
}

function parseMd(md: string): RenderedBlock[] {
  const lines = md.split('\n');
  const blocks: RenderedBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Heading
    const hm = line.match(/^(#{1,3})\s+(.+)/);
    if (hm) {
      const text = hm[2];
      blocks.push({
        type: 'heading',
        level: hm[1].length,
        id: slugify(text.replace(/`/g, '')),
        text,
      });
      i++;
      continue;
    }

    // Code block
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      blocks.push({ type: 'code', lang, code: codeLines.join('\n') });
      continue;
    }

    // HR
    if (/^---+$/.test(line.trim())) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    // Unordered list
    if (/^[\-\*] /.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[\-\*] /.test(lines[i])) {
        items.push(lines[i].replace(/^[\-\*] /, ''));
        i++;
      }
      blocks.push({ type: 'ul', items });
      continue;
    }

    // Ordered list
    if (/^\d+\. /.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\. /.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\. /, ''));
        i++;
      }
      blocks.push({ type: 'ol', items });
      continue;
    }

    // Paragraph (skip blank lines)
    if (line.trim()) {
      const paraLines: string[] = [];
      while (i < lines.length && lines[i].trim() && !lines[i].startsWith('#') && !lines[i].startsWith('```') && !/^[\-\*] /.test(lines[i]) && !/^\d+\. /.test(lines[i]) && !/^---/.test(lines[i])) {
        paraLines.push(lines[i]);
        i++;
      }
      blocks.push({ type: 'paragraph', text: paraLines.join(' ') });
      continue;
    }

    i++;
  }

  return blocks;
}

function inlineHtml(text: string): string {
  // Bold
  let s = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Inline code
  s = s.replace(/`([^`]+)`/g, '<code style="font-family:JetBrains Mono,monospace;font-size:0.88em;background:var(--bg);border:1px solid var(--line);padding:2px 6px;border-radius:4px">$1</code>');
  // Links
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer" style="color:var(--accent);text-decoration:underline">$1</a>');
  return s;
}

function BlockView({ block }: { block: RenderedBlock }) {
  if (block.type === 'hr') {
    return <hr style={{ border: 'none', borderTop: '1px solid var(--line)', margin: '28px 0' }} />;
  }

  if (block.type === 'heading') {
    const Tag = `h${block.level ?? 2}` as 'h1' | 'h2' | 'h3';
    const sizes: Record<number, number> = { 1: 32, 2: 22, 3: 16 };
    const size = sizes[block.level ?? 2] ?? 18;
    return (
      <Tag
        id={block.id}
        style={{
          fontSize: size,
          fontWeight: 700,
          color: 'var(--ink)',
          margin: `${block.level === 1 ? '0 0 16px' : '32px 0 12px'}`,
          lineHeight: 1.25,
          scrollMarginTop: 72,
        }}
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: inlineHtml(block.text ?? '') }}
      />
    );
  }

  if (block.type === 'code') {
    const code = block.code ?? '';
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
        <CopyCodeButton code={code} />
      </div>
    );
  }

  if (block.type === 'paragraph') {
    return (
      <p
        style={{ fontSize: 15, lineHeight: 1.7, color: 'var(--ink)', margin: '12px 0' }}
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: inlineHtml(block.text ?? '') }}
      />
    );
  }

  if (block.type === 'ul') {
    return (
      <ul style={{ margin: '10px 0', paddingLeft: 22 }}>
        {(block.items ?? []).map((item, idx) => (
          <li
            key={idx}
            style={{ fontSize: 14, lineHeight: 1.7, color: 'var(--ink)', marginBottom: 4 }}
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{ __html: inlineHtml(item) }}
          />
        ))}
      </ul>
    );
  }

  if (block.type === 'ol') {
    return (
      <ol style={{ margin: '10px 0', paddingLeft: 22 }}>
        {(block.items ?? []).map((item, idx) => (
          <li
            key={idx}
            style={{ fontSize: 14, lineHeight: 1.7, color: 'var(--ink)', marginBottom: 4 }}
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{ __html: inlineHtml(item) }}
          />
        ))}
      </ol>
    );
  }

  return null;
}

// ── Flow Diagram ───────────────────────────────────────────────────────────

function FlowDiagram() {
  return (
    <div className="protocol-flow-diagram" style={{ marginBottom: 36 }}>
      <p style={{ margin: '0 0 16px', fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
        How it works
      </p>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 0,
          flexWrap: 'nowrap',
          overflowX: 'auto',
          paddingBottom: 4,
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
          {['Secrets vault', 'Rate limits', 'Streaming', 'Run history'].map((item) => (
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
openapi_spec_url: https://docs.stripe.com/api/openapi.json
base_url: https://api.stripe.com
auth: bearer
secrets: [STRIPE_SECRET_KEY]`;

const HOSTED_YAML = `name: flyfast
type: hosted
runtime: python3.12
openapi_spec: ./openapi.yaml
build: pip install .
run: uvicorn flyfast.server:app --port 8000`;

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
            <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', background: 'rgba(99,102,241,0.1)', color: '#6366f1', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Live</span>
          </div>
          <div style={{ position: 'relative' }}>
            <pre style={{
              background: 'var(--terminal-bg, #0e0e0c)',
              color: 'var(--terminal-ink, #d4d4c8)',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 11.5,
              padding: '16px',
              margin: 0,
              lineHeight: 1.8,
              overflowX: 'auto',
            }}>
              {PROXIED_YAML}
            </pre>
            <button
              type="button"
              onClick={() => copy(PROXIED_YAML, setCopiedLeft)}
              style={{
                position: 'absolute', top: 8, right: 8,
                fontSize: 10, padding: '2px 8px',
                background: 'rgba(255,255,255,0.1)',
                border: '1px solid rgba(255,255,255,0.15)',
                borderRadius: 4,
                color: copiedLeft ? '#7bffc0' : 'rgba(255,255,255,0.5)',
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
            <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', background: 'rgba(99,102,241,0.1)', color: '#6366f1', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Live</span>
          </div>
          <div style={{ position: 'relative' }}>
            <pre style={{
              background: 'var(--terminal-bg, #0e0e0c)',
              color: 'var(--terminal-ink, #d4d4c8)',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 11.5,
              padding: '16px',
              margin: 0,
              lineHeight: 1.8,
              overflowX: 'auto',
            }}>
              {HOSTED_YAML}
            </pre>
            <button
              type="button"
              onClick={() => copy(HOSTED_YAML, setCopiedRight)}
              style={{
                position: 'absolute', top: 8, right: 8,
                fontSize: 10, padding: '2px 8px',
                background: 'rgba(255,255,255,0.1)',
                border: '1px solid rgba(255,255,255,0.15)',
                borderRadius: 4,
                color: copiedRight ? '#7bffc0' : 'rgba(255,255,255,0.5)',
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

// ── ProtocolPage ───────────────────────────────────────────────────────────

export function ProtocolPage() {
  const toc = useRef<TocItem[]>(extractToc(protocolMd));
  const blocks = useRef<RenderedBlock[]>(parseMd(protocolMd));
  const [tocOpen, setTocOpen] = useState(false);

  useEffect(() => {
    document.title = 'The Floom Protocol';
    return () => {
      document.title = 'Floom: infra for agentic work';
    };
  }, []);

  return (
    <div className="page-root" data-testid="protocol-page">
      <TopBar />

      <main
        style={{
          maxWidth: 1080,
          margin: '0 auto',
          padding: '48px 24px 80px',
          display: 'grid',
          gridTemplateColumns: '220px 1fr',
          gap: 48,
          alignItems: 'start',
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

          {/* Rendered markdown */}
          {blocks.current.map((block, idx) => (
            <BlockView key={idx} block={block} />
          ))}

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
                Self-host, fork, or contribute. Runtime packages in the monorepo.
              </p>
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <a
                href="https://github.com/floomhq/floom-monorepo"
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

          {/* Example manifests */}
          <div style={{ marginTop: 32 }}>
            <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 10 }}>
              Example manifests
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {['flyfast', 'blast-radius', 'opendraft', 'bouncer', 'openanalytics'].map((slug) => (
                <a
                  key={slug}
                  href={`https://github.com/floomhq/floom-monorepo/tree/main/examples/${slug}/floom.yaml`}
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
              background: 'var(--terminal-bg, #0e0e0c)',
              color: 'var(--terminal-ink, #d4d4c8)',
              borderRadius: 10,
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 12,
              lineHeight: 1.8,
            }}
          >
            <span style={{ color: 'rgba(255,255,255,0.4)' }}># Self-host Floom</span>
            {'\n'}
            <span style={{ color: 'rgba(255,255,255,0.4)' }}>$</span> docker run -p 3051:3051 ghcr.io/floomhq/floom-monorepo:latest
          </div>
        </article>
      </main>
      <Footer />
      <FeedbackButton />
    </div>
  );
}
