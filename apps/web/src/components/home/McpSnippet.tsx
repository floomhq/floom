/**
 * McpSnippet — "Add any app to Claude in 3 lines."
 *
 * Dark, syntax-highlighted (by hand, no external lib) JSON block with
 * a Copy button. Reader should be able to paste into Claude Desktop's
 * config and get a working Floom tool instantly.
 */
import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { SectionEyebrow } from './SectionEyebrow';

const SNIPPET = `{
  "mcpServers": {
    "floom-uuid": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://preview.floom.dev/mcp/app/uuid"]
    }
  }
}`;

/**
 * Render the JSON with a tiny color scheme (keys / strings / punctuation).
 * Written by hand so we avoid a full JS-syntax-highlighter dependency.
 */
function renderHighlightedJson(raw: string): React.ReactNode {
  // Very small tokenizer: keys ("key":), strings ("val"), braces, brackets.
  const tokens: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '"') {
      // Consume string
      const start = i;
      i += 1;
      while (i < raw.length && raw[i] !== '"') {
        if (raw[i] === '\\') i += 2;
        else i += 1;
      }
      i += 1;
      const str = raw.slice(start, i);
      // Is it a key (followed by optional ws + :)? Peek ahead.
      let j = i;
      while (j < raw.length && (raw[j] === ' ' || raw[j] === '\t')) j += 1;
      const isKey = raw[j] === ':';
      tokens.push(
        <span
          key={`s-${key++}`}
          style={{ color: isKey ? '#7dd3fc' : '#6ee7b7' }}
        >
          {str}
        </span>,
      );
    } else if (ch === '{' || ch === '}' || ch === '[' || ch === ']' || ch === ',' || ch === ':') {
      tokens.push(
        <span key={`p-${key++}`} style={{ color: '#94a3b8' }}>
          {ch}
        </span>,
      );
      i += 1;
    } else {
      // Whitespace / newline / other
      let start = i;
      while (
        i < raw.length &&
        raw[i] !== '"' &&
        raw[i] !== '{' &&
        raw[i] !== '}' &&
        raw[i] !== '[' &&
        raw[i] !== ']' &&
        raw[i] !== ',' &&
        raw[i] !== ':'
      ) {
        i += 1;
      }
      tokens.push(
        <span key={`w-${key++}`} style={{ color: '#e2e8f0' }}>
          {raw.slice(start, i)}
        </span>,
      );
    }
  }
  return tokens;
}

export function McpSnippet() {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(SNIPPET);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked — no-op */
    }
  };

  return (
    <section
      data-testid="home-mcp-snippet"
      data-section="mcp-snippet"
      style={{
        background: 'var(--bg)',
        padding: '72px 24px',
      }}
    >
      <div style={{ maxWidth: 820, margin: '0 auto' }}>
        <header style={{ textAlign: 'center', marginBottom: 28 }}>
          <SectionEyebrow testid="mcp-snippet-eyebrow">
            For Claude, Cursor, Zed · any MCP client
          </SectionEyebrow>
          <h2
            style={{
              fontFamily: "'DM Serif Display', Georgia, serif",
              fontWeight: 400,
              fontSize: 40,
              lineHeight: 1.1,
              letterSpacing: '-0.02em',
              color: 'var(--ink)',
              margin: '0 0 12px',
            }}
          >
            Add any app to Claude in 3 lines.
          </h2>
          <p
            style={{
              fontSize: 15,
              color: 'var(--muted)',
              lineHeight: 1.55,
              maxWidth: 520,
              margin: '0 auto',
            }}
          >
            Paste into Claude Desktop&apos;s{' '}
            <code
              style={{
                fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                fontSize: 14,
                background: 'var(--card)',
                border: '1px solid var(--line)',
                padding: '2px 6px',
                borderRadius: 6,
              }}
            >
              claude_desktop_config.json
            </code>
            . Restart Claude. That&apos;s it.
          </p>
        </header>

        <div
          style={{
            position: 'relative',
            background: '#0b1220',
            border: '1px solid rgba(255,255,255,0.06)',
            borderRadius: 14,
            padding: '20px 22px',
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            fontSize: 13.5,
            lineHeight: 1.7,
            overflowX: 'auto',
          }}
        >
          <button
            type="button"
            onClick={copy}
            data-testid="mcp-snippet-copy"
            aria-label={copied ? 'Copied' : 'Copy snippet'}
            style={{
              position: 'absolute',
              top: 14,
              right: 14,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              background: copied ? 'var(--accent)' : 'rgba(255,255,255,0.06)',
              color: copied ? '#fff' : '#e2e8f0',
              border: '1px solid ' + (copied ? 'var(--accent)' : 'rgba(255,255,255,0.1)'),
              borderRadius: 8,
              padding: '7px 11px',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
              transition: 'background 140ms ease, color 140ms ease',
            }}
          >
            {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
          <pre style={{ margin: 0, whiteSpace: 'pre', color: '#e2e8f0' }}>
            {renderHighlightedJson(SNIPPET)}
          </pre>
        </div>
      </div>
    </section>
  );
}
