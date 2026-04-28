import { useState, useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { useLocation } from 'react-router-dom';

// v26 "Copy for Claude" affordance. Globally visible button + tabbed popover.
//
// launch-mvp: collapsed to MCP + CLI tabs only.
//   - MCP tab: single canonical JSON config block (works with all MCP clients).
//   - CLI tab: install + auth login snippet.
//   - Drop per-client variants (Claude/Cursor/Codex) — they were identical.

type TabId = 'mcp' | 'cli';

interface TabSpec {
  id: TabId;
  label: string;
  description: string;
  snippet: string;
}

const MCP_JSON = '{ "mcpServers": { "floom": { "url": "https://floom.dev/mcp" } } }';
const CLI_SNIPPET = 'curl -fsSL https://floom.dev/install.sh | bash\nfloom auth login --token=floom_agent_••••••';

const TABS: TabSpec[] = [
  {
    id: 'mcp',
    label: 'MCP',
    description: 'Works with any MCP client (Claude Desktop, Cursor, Codex, and more)',
    snippet: MCP_JSON,
  },
  {
    id: 'cli',
    label: 'CLI',
    description: 'Install CLI + authenticate',
    snippet: CLI_SNIPPET,
  },
];

interface Props {
  variant?: 'desktop' | 'mobile';
}

export function CopyForClaudeButton({ variant = 'desktop' }: Props = {}) {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>('mcp');
  const [copied, setCopied] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const location = useLocation();

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open]);

  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  const currentTab = TABS.find((t) => t.id === activeTab) ?? TABS[0]!;

  async function handleCopy() {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(currentTab.snippet);
      } else {
        const ta = document.createElement('textarea');
        ta.value = currentTab.snippet;
        ta.setAttribute('readonly', '');
        ta.style.position = 'absolute';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Silent fail.
    }
  }

  const popoverContents = (
    <>
      <div
        role="tablist"
        aria-label="Select tool"
        style={{
          display: 'flex',
          borderBottom: '1px solid var(--line)',
          background: 'var(--bg)',
          padding: '0 4px',
          overflowX: 'auto',
        }}
      >
        {TABS.map((tab) => {
          const isOn = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isOn}
              data-testid={`mcp-tab-${tab.id}`}
              onClick={() => {
                setActiveTab(tab.id);
                setCopied(false);
              }}
              style={{
                padding: '10px 14px',
                fontSize: 12,
                fontWeight: isOn ? 700 : 500,
                border: 'none',
                background: 'transparent',
                color: isOn ? 'var(--ink)' : 'var(--muted)',
                borderBottom: isOn ? '2px solid var(--accent)' : '2px solid transparent',
                marginBottom: -1,
                cursor: 'pointer',
                fontFamily: 'inherit',
                whiteSpace: 'nowrap',
                transition: 'color .1s, border-color .1s',
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      <div style={{ padding: '14px 14px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <span
            style={{
              fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: 10,
              fontWeight: 700,
              color: 'var(--muted)',
              letterSpacing: '0.06em',
              textTransform: 'uppercase' as const,
            }}
          >
            {currentTab.description}
          </span>
          <button
            type="button"
            data-testid={`mcp-copy-${activeTab}`}
            onClick={() => void handleCopy()}
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
              textTransform: 'uppercase' as const,
            }}
            aria-label={copied ? 'Copied' : `Copy ${activeTab} snippet`}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <pre
          style={{
            fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: 11.5,
            color: 'var(--ink)',
            background: 'var(--bg)',
            border: '1px solid var(--line)',
            borderRadius: 6,
            padding: '10px 12px',
            overflowX: 'auto',
            whiteSpace: 'pre',
            lineHeight: 1.5,
            margin: 0,
          }}
        >
          {currentTab.snippet}
        </pre>
        {activeTab === 'cli' && (
          <p style={{ fontSize: 11, color: 'var(--muted)', margin: '8px 0 0', lineHeight: 1.5 }}>
            Get your agent token on your{' '}
            <a href="/home" style={{ color: 'var(--accent)', textDecoration: 'none', fontWeight: 500 }}>
              home page
            </a>
          </p>
        )}
      </div>
    </>
  );

  const popoverBaseStyle: CSSProperties = {
    position: 'absolute',
    zIndex: 60,
    width: 420,
    background: 'var(--card)',
    border: '1px solid var(--line)',
    borderRadius: 12,
    boxShadow: 'var(--shadow-3, 0 12px 32px rgba(14,14,12,0.14))',
    overflow: 'hidden',
  };

  if (variant === 'mobile') {
    return (
      <div ref={wrapRef} style={{ position: 'fixed', bottom: 18, right: 18, zIndex: 30 }} data-testid="mcp-copy-mobile-wrap">
        <button
          ref={triggerRef}
          type="button"
          data-testid="mcp-copy-mobile"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Get install snippet"
          onClick={() => setOpen((v) => !v)}
          style={{
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
          }}
        >
          <ClipboardIcon />
          Get install snippet
        </button>
        {open && (
          <div role="menu" data-testid="mcp-popover" style={{ ...popoverBaseStyle, top: 'auto', bottom: 'calc(100% + 8px)', right: 0, width: 340 }}>
            {popoverContents}
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
        aria-label="Get install snippet for MCP or CLI"
        onClick={() => setOpen((v) => !v)}
        style={{
          position: 'relative',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '7px 12px',
          borderRadius: 8,
          border: '1px solid var(--line)',
          background: 'var(--card)',
          fontSize: 12.5,
          fontWeight: 600,
          color: 'var(--ink)',
          cursor: 'pointer',
          fontFamily: 'inherit',
          transition: 'all 0.12s',
        }}
      >
        <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--accent)', display: 'inline-block' }} />
        <ClipboardIcon />
        Get install snippet
      </button>
      {open && (
        <div role="menu" data-testid="mcp-popover" style={{ ...popoverBaseStyle, top: 'calc(100% + 8px)', right: 0 }}>
          {popoverContents}
        </div>
      )}
    </div>
  );
}

function ClipboardIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  );
}
