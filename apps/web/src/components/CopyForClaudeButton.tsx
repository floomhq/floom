import { useState, useEffect, useRef, useMemo } from 'react';
import type { CSSProperties } from 'react';
import { useLocation } from 'react-router-dom';

// v23 "Copy for Claude" affordance. Globally visible button + 3-row popover.
//
// Federico-locked decisions (2026-04-26):
//   • One neutral palette — no category tints. var(--card) bg, var(--line)
//     border, monospace text. Result content carries meaning, not colour.
//   • Row 1 — MCP server config: { "mcpServers": { "floom": { "url":
//     "https://floom.dev/mcp" } } }   <- verified path. Earlier wireframes
//     said /mcp/sse; that was wrong, do NOT use it.
//   • Row 2 — CLI install: curl -fsSL https://floom.dev/install.sh | bash
//   • Row 3 — context-aware. Hidden on routes where it adds nothing:
//       /p/:slug          → run THIS app via the CLI
//       /me, /me/*        → generic "use Floom from your agent" snippet
//       /studio/:slug     → deploy-via-CLI snippet for THIS creator's app
//       Other routes      → row 3 hidden (only Row 1 + Row 2)
//
// Behaviour: click toggles, click-outside closes, Esc closes. Per-row
// "Copy" buttons flash green for 1.5s after clipboard write succeeds.

type ContextSnippet = {
  label: string;
  snippet: string;
};

const MCP_CONFIG_SNIPPET = `{ "mcpServers": { "floom": { "url": "https://floom.dev/mcp" } } }`;
const CLI_INSTALL_SNIPPET = `curl -fsSL https://floom.dev/install.sh | bash`;

function buildContextSnippet(pathname: string): ContextSnippet | null {
  // /p/:slug — run THIS app
  const pMatch = pathname.match(/^\/p\/([^/]+)/);
  if (pMatch) {
    const slug = pMatch[1];
    return {
      label: `For this app (${slug})`,
      snippet: `floom run ${slug}`,
    };
  }
  // /studio/:slug — creator-side deploy snippet for THIS app. Skip the
  // bare /studio root and /studio/build flow (no slug to bind).
  const studioMatch = pathname.match(/^\/studio\/([^/]+)/);
  if (studioMatch && studioMatch[1] !== 'build') {
    const slug = studioMatch[1];
    return {
      label: `For this app (${slug})`,
      snippet: `floom deploy ${slug}`,
    };
  }
  // /me + sub-pages — generic agent snippet
  if (pathname === '/me' || pathname.startsWith('/me/')) {
    return {
      label: 'For this page (your account)',
      snippet: `floom auth login\nfloom apps list`,
    };
  }
  // Elsewhere: hide row 3
  return null;
}

const popoverStyle: CSSProperties = {
  position: 'absolute',
  top: 'calc(100% + 8px)',
  right: 0,
  zIndex: 60,
  width: 380,
  background: 'var(--card)',
  border: '1px solid var(--line)',
  borderRadius: 12,
  boxShadow: 'var(--shadow-3, 0 12px 32px rgba(14,14,12,0.14))',
  padding: 6,
};

const rowStyle: CSSProperties = {
  padding: '11px 12px',
  borderRadius: 8,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

const rowLabelStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 10.5,
  fontWeight: 700,
  color: 'var(--muted)',
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
};

const snippetStyle: CSSProperties = {
  fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 11.5,
  color: 'var(--ink)',
  background: 'var(--bg)',
  border: '1px solid var(--line)',
  borderRadius: 6,
  padding: '8px 10px',
  overflowX: 'auto',
  whiteSpace: 'pre',
  lineHeight: 1.45,
  margin: 0,
};

interface Props {
  /**
   * Mobile variant: render as a fixed bottom-right pill rather than the
   * desktop popover-anchored button. The popover panel is reused; only
   * the trigger chrome differs.
   */
  variant?: 'desktop' | 'mobile';
}

export function CopyForClaudeButton({ variant = 'desktop' }: Props = {}) {
  const [open, setOpen] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const location = useLocation();

  const contextRow = useMemo(
    () => buildContextSnippet(location.pathname),
    [location.pathname],
  );

  // Click outside to close
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  // Esc to close, returns focus to trigger
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Close popover on route change
  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  async function copyText(key: string, text: string) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        // Fallback for non-secure contexts (older browsers / http preview).
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'absolute';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopiedKey(key);
      window.setTimeout(() => {
        setCopiedKey((k) => (k === key ? null : k));
      }, 1500);
    } catch {
      // Silent fail — don't block the UI on a clipboard error.
    }
  }

  const triggerLabel = 'Copy for Claude';

  const desktopTriggerStyle: CSSProperties = {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '7px 12px',
    borderRadius: 8,
    border: '1px solid var(--line)',
    background: copiedKey === '__all__' ? 'var(--accent-soft)' : 'var(--card)',
    fontSize: 12.5,
    fontWeight: 600,
    color: 'var(--ink)',
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: 'all 0.12s',
  };

  const mobileTriggerStyle: CSSProperties = {
    position: 'fixed',
    bottom: 18,
    right: 18,
    zIndex: 30,
    background: 'var(--ink)',
    color: '#fff',
    borderRadius: 999,
    padding: '11px 16px',
    fontSize: 12.5,
    fontWeight: 600,
    boxShadow: '0 12px 32px rgba(14,14,12,0.18)',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 7,
    border: '1px solid var(--ink)',
    cursor: 'pointer',
    fontFamily: 'inherit',
  };

  function CopyButton({
    rowKey,
    text,
  }: {
    rowKey: string;
    text: string;
  }) {
    const isCopied = copiedKey === rowKey;
    return (
      <button
        type="button"
        data-testid={`mcp-copy-row-${rowKey}`}
        onClick={(e) => {
          e.stopPropagation();
          void copyText(rowKey, text);
        }}
        style={{
          fontSize: 10.5,
          color: 'var(--accent)',
          background: 'var(--accent-soft)',
          border: '1px solid var(--accent-border)',
          padding: '2px 8px',
          borderRadius: 6,
          fontWeight: 600,
          cursor: 'pointer',
          letterSpacing: '0.04em',
          fontFamily: 'inherit',
          textTransform: 'uppercase',
        }}
        aria-label={isCopied ? 'Copied' : `Copy ${rowKey}`}
      >
        {isCopied ? 'Copied' : 'Copy'}
      </button>
    );
  }

  // Mobile pill: position is fixed bottom-right, the popover anchors to
  // the trigger so it floats up-left from the pill.
  if (variant === 'mobile') {
    return (
      <div
        ref={wrapRef}
        style={{
          position: 'fixed',
          bottom: 18,
          right: 18,
          zIndex: 30,
        }}
        data-testid="mcp-copy-mobile-wrap"
      >
        <button
          ref={triggerRef}
          type="button"
          data-testid="mcp-copy-mobile"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Copy MCP/CLI snippets"
          onClick={() => setOpen((v) => !v)}
          style={mobileTriggerStyle}
        >
          <ClipboardIcon />
          {triggerLabel}
        </button>
        {open && (
          <div
            role="menu"
            data-testid="mcp-popover"
            style={{
              ...popoverStyle,
              top: 'auto',
              bottom: 'calc(100% + 8px)',
              right: 0,
              width: 320,
            }}
          >
            <PopoverContents
              contextRow={contextRow}
              CopyButton={CopyButton}
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        ref={triggerRef}
        type="button"
        data-testid="topbar-copy-for-claude"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Copy for Claude / MCP / CLI snippets"
        onClick={() => setOpen((v) => !v)}
        style={desktopTriggerStyle}
      >
        <span
          aria-hidden="true"
          style={{
            width: 6,
            height: 6,
            borderRadius: 999,
            background: 'var(--accent)',
            display: 'inline-block',
          }}
        />
        <ClipboardIcon />
        {triggerLabel}
      </button>
      {open && (
        <div
          role="menu"
          data-testid="mcp-popover"
          style={popoverStyle}
        >
          <PopoverContents contextRow={contextRow} CopyButton={CopyButton} />
        </div>
      )}
    </div>
  );
}

function PopoverContents({
  contextRow,
  CopyButton,
}: {
  contextRow: ContextSnippet | null;
  CopyButton: (props: { rowKey: string; text: string }) => JSX.Element;
}) {
  return (
    <>
      <div style={rowStyle} data-testid="mcp-row-mcp">
        <div style={rowLabelStyle}>
          <span>MCP server config</span>
          <CopyButton rowKey="mcp" text={MCP_CONFIG_SNIPPET} />
        </div>
        <pre style={snippetStyle}>{MCP_CONFIG_SNIPPET}</pre>
      </div>
      <div
        aria-hidden="true"
        style={{
          height: 1,
          background: 'var(--line, rgba(14,14,12,0.08))',
          margin: '0 12px',
        }}
      />
      <div style={rowStyle} data-testid="mcp-row-cli">
        <div style={rowLabelStyle}>
          <span>CLI install</span>
          <CopyButton rowKey="cli" text={CLI_INSTALL_SNIPPET} />
        </div>
        <pre style={snippetStyle}>{CLI_INSTALL_SNIPPET}</pre>
      </div>
      {contextRow && (
        <>
          <div
            aria-hidden="true"
            style={{
              height: 1,
              background: 'var(--line, rgba(14,14,12,0.08))',
              margin: '0 12px',
            }}
          />
          <div style={rowStyle} data-testid="mcp-row-context">
            <div style={rowLabelStyle}>
              <span>{contextRow.label}</span>
              <CopyButton rowKey="context" text={contextRow.snippet} />
            </div>
            <pre style={snippetStyle}>{contextRow.snippet}</pre>
          </div>
        </>
      )}
    </>
  );
}

function ClipboardIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  );
}
