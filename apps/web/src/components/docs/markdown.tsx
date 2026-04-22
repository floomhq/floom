import React, { useState } from 'react';
import { Link } from 'react-router-dom';

export interface TocItem {
  id: string;
  text: string;
  level: number;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
}

export function extractToc(md: string): TocItem[] {
  const lines = md.split('\n');
  const toc: TocItem[] = [];
  for (const line of lines) {
    const match = line.match(/^(#{1,3})\s+(.+)/);
    if (!match) continue;
    toc.push({
      id: slugify(match[2].replace(/`/g, '')),
      text: match[2].replace(/`/g, ''),
      level: match[1].length,
    });
  }
  return toc;
}

function childrenToText(children: React.ReactNode): string {
  if (typeof children === 'string') return children;
  if (typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(childrenToText).join('');
  if (React.isValidElement(children)) {
    return childrenToText((children.props as { children?: React.ReactNode }).children);
  }
  return '';
}

function headingStyle(level: number): React.CSSProperties {
  const sizes: Record<number, number> = { 1: 32, 2: 22, 3: 16 };
  return {
    fontSize: sizes[level] ?? 18,
    fontWeight: 700,
    color: 'var(--ink)',
    margin: `${level === 1 ? '0 0 16px' : '32px 0 12px'}`,
    lineHeight: 1.25,
    scrollMarginTop: 72,
  };
}

const linkStyle: React.CSSProperties = {
  color: 'var(--accent)',
  textDecoration: 'underline',
};

export const lightCodeBlockStyle: React.CSSProperties = {
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
};

export function CopyCodeButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      data-testid="copy-btn"
      onClick={() => {
        try {
          navigator.clipboard.writeText(code).catch(() => {});
        } catch {
          // ignore clipboard errors
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
        transition: 'color 0.15s ease',
      }}
    >
      {copied ? 'Copied!' : 'Copy'}
    </button>
  );
}

export const markdownComponents = {
  h1: ({ children }: { children?: React.ReactNode }) => {
    const text = childrenToText(children);
    return <h1 id={slugify(text.replace(/`/g, ''))} style={headingStyle(1)}>{children}</h1>;
  },
  h2: ({ children }: { children?: React.ReactNode }) => {
    const text = childrenToText(children);
    return <h2 id={slugify(text.replace(/`/g, ''))} style={headingStyle(2)}>{children}</h2>;
  },
  h3: ({ children }: { children?: React.ReactNode }) => {
    const text = childrenToText(children);
    return <h3 id={slugify(text.replace(/`/g, ''))} style={headingStyle(3)}>{children}</h3>;
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
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => {
    if (href && href.startsWith('/')) {
      return (
        <Link to={href} style={linkStyle}>
          {children}
        </Link>
      );
    }
    const isHash = Boolean(href && href.startsWith('#'));
    return (
      <a
        href={href}
        target={isHash ? undefined : '_blank'}
        rel={isHash ? undefined : 'noreferrer'}
        style={linkStyle}
      >
        {children}
      </a>
    );
  },
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
      <div style={{ position: 'relative', margin: '16px 0' }}>
        <pre style={lightCodeBlockStyle}>
          <code className={className}>{raw}</code>
        </pre>
        <CopyCodeButton code={raw} />
      </div>
    );
  },
  pre: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
};
