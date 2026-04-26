import { useState, useEffect, useRef, useMemo } from 'react';
import type { CSSProperties } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useSession } from '../hooks/useSession';
import { useAgentTokens } from '../hooks/useAgentTokens';

// v23 "Copy for Claude" affordance. Globally visible button + 3-row popover.
//
// Federico-locked decisions (2026-04-26):
//   • One neutral palette — no category tints. var(--card) bg, var(--line)
//     border, monospace text. Result content carries meaning, not colour.
//   • Row 1 — MCP server config. Pretty-printed JSON (multi-line) so it
//     fits the popover width without truncation. Authed users get the
//     `headers.Authorization: Bearer <your_floom_agent_token>` form so
//     copy-paste actually works against Floom's MCP endpoint; anon users
//     get the URL-only form. Verified path is /mcp (NOT /mcp/sse — that
//     was an earlier wireframe error).
//   • Row 2 — CLI install: curl -fsSL https://floom.dev/install.sh | bash
//   • Row 3 — context-aware AND token-aware:
//       /p/:slug          → run THIS app via the CLI
//       /me, /me/*        → generic "use Floom from your agent" snippet
//       /studio/:slug     → deploy-via-CLI snippet for THIS creator's app
//       Other routes      → row 3 hidden (only Row 1 + Row 2)
//     For authed users with ≥1 agent token: snippet shows real working
//     command + a clickable note pointing at /me/agent-keys.
//     For authed users with 0 tokens: snippet replaced by a CTA pointing
//     at /me/agent-keys with helper text above.
//     For anon users: row 3 hides entirely (no auth context to bind).
//
// Behaviour: click toggles, click-outside closes, Esc closes. Per-row
// "Copy" buttons flash green for 1.5s after clipboard write succeeds.

type AuthedSnippet = {
  kind: 'snippet';
  label: string;
  snippet: string;
};

type AuthedCta = {
  kind: 'cta';
  label: string;
  helper: string;
  ctaText: string;
  ctaHref: string;
};

type ContextRow = AuthedSnippet | AuthedCta;

const AGENT_KEYS_PATH = '/me/agent-keys';
const FLOOM_TOKEN_PLACEHOLDER = '<your_floom_agent_token>';

const MCP_CONFIG_ANON = JSON.stringify(
  {
    mcpServers: {
      floom: {
        url: 'https://floom.dev/mcp',
      },
    },
  },
  null,
  2,
);

const MCP_CONFIG_AUTHED = JSON.stringify(
  {
    mcpServers: {
      floom: {
        url: 'https://floom.dev/mcp',
        headers: {
          Authorization: `Bearer ${FLOOM_TOKEN_PLACEHOLDER}`,
        },
      },
    },
  },
  null,
  2,
);

const CLI_INSTALL_SNIPPET = `curl -fsSL https://floom.dev/install.sh | bash`;

function buildContextRow(
  pathname: string,
  authedAndHasTokens: boolean | null,
): ContextRow | null {
  // /p/:slug — run THIS app. Same snippet for anon + authed; CLI prompts
  // for `floom auth login` if no creds yet.
  const pMatch = pathname.match(/^\/p\/([^/]+)/);
  if (pMatch) {
    const slug = pMatch[1];
    return {
      kind: 'snippet',
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
      kind: 'snippet',
      label: `For this app (${slug})`,
      snippet: `floom deploy ${slug}`,
    };
  }
  // /me + sub-pages — token-aware. Anon users skip row 3 entirely (no
  // auth context). Authed users with tokens get a real command + helper
  // note. Authed users with 0 tokens get a CTA to mint one.
  if (pathname === '/me' || pathname.startsWith('/me/')) {
    if (authedAndHasTokens === null) {
      // Not authed — hide row 3.
      return null;
    }
    if (authedAndHasTokens) {
      return {
        kind: 'snippet',
        label: 'For this page (your account)',
        snippet: `floom auth login --token ${FLOOM_TOKEN_PLACEHOLDER}\nfloom apps list`,
      };
    }
    return {
      kind: 'cta',
      label: 'For this page (your account)',
      helper:
        'Floom apps need an agent token to call from Claude or Cursor.',
      ctaText: 'Mint an agent token first →',
      ctaHref: AGENT_KEYS_PATH,
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
  // Pretty-printed JSON spans multiple lines so the snippet fits the
  // 380px popover width without truncation. Keep overflowX:auto as a
  // belt-and-braces fallback for unusually long lines (e.g. tokens
  // glued back into a single line if a future snippet rebuilds inline).
  overflowX: 'auto',
  whiteSpace: 'pre',
  lineHeight: 1.45,
  margin: 0,
};

// Helper note above an MCP/agent-token snippet. Plain prose, slightly
// muted, smaller than the body so it reads as guidance not as a
// snippet body.
const helperNoteStyle: CSSProperties = {
  fontSize: 11.5,
  color: 'var(--muted)',
  lineHeight: 1.45,
  margin: 0,
};

const inlineCodeStyle: CSSProperties = {
  fontFamily:
    '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 11,
  background: 'var(--bg)',
  border: '1px solid var(--line)',
  borderRadius: 4,
  padding: '0 4px',
  color: 'var(--ink)',
};

const inlineLinkStyle: CSSProperties = {
  color: 'var(--accent)',
  textDecoration: 'underline',
  fontWeight: 500,
};

// Mint-token CTA: row 3 replaces the snippet pre with a clear text link
// to /me/agent-keys for authed users with 0 tokens.
const ctaLinkStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  alignSelf: 'flex-start',
  padding: '6px 10px',
  borderRadius: 6,
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--accent)',
  background: 'var(--accent-soft)',
  border: '1px solid var(--accent-border)',
  textDecoration: 'none',
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

  // Auth-aware: anon users get the URL-only MCP snippet (no token yet to
  // bind) and skip row 3 on /me*. Authed users get the Authorization-
  // header form so copy-paste works, and row 3 branches on whether they
  // already have an agent token minted.
  const { isAuthenticated } = useSession();
  // Only fire /auth/api-key/list for authed users. Anon visitors would
  // get a 401 from the endpoint and we don't need the data — row 3 hides
  // entirely on /me* for them anyway.
  const { tokens, loading: tokensLoading } = useAgentTokens({
    enabled: isAuthenticated,
  });
  // Resolved auth-and-token signal for contextRow:
  //   null  → not authed (anon) → row 3 hides on /me*
  //   true  → authed with ≥1 token → row 3 shows real snippet + helper
  //   false → authed with 0 tokens → row 3 shows mint-token CTA
  // While the token list is loading we treat it as null to avoid a flash
  // of the CTA before the cache hydrates. Settled state then renders
  // correctly without a re-mount.
  const authedAndHasTokens: boolean | null = !isAuthenticated
    ? null
    : tokens === null || tokensLoading
    ? null
    : tokens.length > 0;

  const mcpConfigSnippet = isAuthenticated ? MCP_CONFIG_AUTHED : MCP_CONFIG_ANON;

  const contextRow = useMemo(
    () => buildContextRow(location.pathname, authedAndHasTokens),
    [location.pathname, authedAndHasTokens],
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
              mcpConfigSnippet={mcpConfigSnippet}
              isAuthenticated={isAuthenticated}
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
          <PopoverContents
            contextRow={contextRow}
            mcpConfigSnippet={mcpConfigSnippet}
            isAuthenticated={isAuthenticated}
            CopyButton={CopyButton}
          />
        </div>
      )}
    </div>
  );
}

function PopoverContents({
  contextRow,
  mcpConfigSnippet,
  isAuthenticated,
  CopyButton,
}: {
  contextRow: ContextRow | null;
  mcpConfigSnippet: string;
  isAuthenticated: boolean;
  CopyButton: (props: { rowKey: string; text: string }) => JSX.Element;
}) {
  return (
    <>
      <div style={rowStyle} data-testid="mcp-row-mcp">
        <div style={rowLabelStyle}>
          <span>MCP server config</span>
          <CopyButton rowKey="mcp" text={mcpConfigSnippet} />
        </div>
        {/* Authed users get the Authorization-header form. Show a one-
            liner above the JSON pointing at /me/agent-keys so the
            placeholder isn't a dead-end. */}
        {isAuthenticated && (
          <div style={helperNoteStyle} data-testid="mcp-row-mcp-note">
            Replace <code style={inlineCodeStyle}>{FLOOM_TOKEN_PLACEHOLDER}</code>{' '}
            with one from{' '}
            <Link
              to={AGENT_KEYS_PATH}
              style={inlineLinkStyle}
              data-testid="mcp-row-mcp-token-link"
            >
              {AGENT_KEYS_PATH}
            </Link>
            .
          </div>
        )}
        <pre style={snippetStyle}>{mcpConfigSnippet}</pre>
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
            {contextRow.kind === 'snippet' ? (
              <>
                <div style={rowLabelStyle}>
                  <span>{contextRow.label}</span>
                  <CopyButton rowKey="context" text={contextRow.snippet} />
                </div>
                {/* Token-aware helper: only on /me* snippets. Other
                    contexts (/p/:slug, /studio/:slug) skip the note —
                    their snippets don't bind to a token. */}
                {contextRow.snippet.includes(FLOOM_TOKEN_PLACEHOLDER) && (
                  <div
                    style={helperNoteStyle}
                    data-testid="mcp-row-context-note"
                  >
                    Use your agent token from{' '}
                    <Link
                      to={AGENT_KEYS_PATH}
                      style={inlineLinkStyle}
                      data-testid="mcp-row-context-token-link"
                    >
                      {AGENT_KEYS_PATH}
                    </Link>
                    .
                  </div>
                )}
                <pre style={snippetStyle}>{contextRow.snippet}</pre>
              </>
            ) : (
              <>
                <div style={rowLabelStyle}>
                  <span>{contextRow.label}</span>
                </div>
                <div
                  style={helperNoteStyle}
                  data-testid="mcp-row-context-helper"
                >
                  {contextRow.helper}
                </div>
                <Link
                  to={contextRow.ctaHref}
                  style={ctaLinkStyle}
                  data-testid="mcp-row-context-cta"
                >
                  {contextRow.ctaText}
                </Link>
              </>
            )}
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
