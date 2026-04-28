/**
 * MvpHomePage — slim one-box authed home for launch-mvp.
 *
 * Single page: token card + install tabs + footer links.
 * No rail, no tabs, no Studio/BYOK/Members/Billing.
 *
 * Routes: /home (post-login redirect target on launch-mvp)
 */

import { useEffect, useState, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useSession, clearSession } from '../hooks/useSession';
import { Logo } from '../components/Logo';
import { TopBar } from '../components/TopBar';
import { PublicFooter } from '../components/public/PublicFooter';
import * as api from '../api/client';
import type { CreatedAgentToken } from '../api/client';

// ---------- constants ----------

const INK = '#0e0e0c';
const MUTED = '#585550';
const ACCENT = '#047857';
const BG = '#fafaf8';
const CARD = '#fff';
const LINE = 'rgba(14,14,12,0.1)';
const MONO = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

// Use the current origin — tokens minted on mvp.floom.dev / v26.floom.dev /
// floom.dev (post-flip) are bound to that host's DB. Hardcoding floom.dev
// breaks the 401-on-cross-host case (Federico hit this 2026-04-28: paste
// from mvp.floom.dev → snippet hardcoded floom.dev → 401 invalid_token).
const HOST_ORIGIN = typeof window !== 'undefined' ? window.location.origin : 'https://floom.dev';

function buildMcpConfig(token: string) {
  // Claude Desktop / Cursor JSON shape (Codex TOML variant in followup).
  return `{
  "mcpServers": {
    "floom": {
      "url": "${HOST_ORIGIN}/mcp",
      "headers": {
        "Authorization": "Bearer ${token}"
      }
    }
  }
}`;
}

function buildCliSnippet(token: string) {
  return `curl -fsSL ${HOST_ORIGIN}/install.sh | bash\nfloom auth login --token=${token}`;
}

// MvpAuthShell removed 2026-04-28: /home now uses standard TopBar +
// PublicFooter for header consistency with the rest of the site.
// (Federico flagged 2x: nav items + avatar shifted x-position when
// going landing → /home.)

// ---------- InstallTabs ----------

type TabId = 'mcp' | 'cli';

function InstallTabs({ token }: { token: string }) {
  const [active, setActive] = useState<TabId>('mcp');
  const [copied, setCopied] = useState(false);

  const mcpSnippet = buildMcpConfig(token);
  const cliSnippet = buildCliSnippet(token);
  const snippet = active === 'mcp' ? mcpSnippet : cliSnippet;

  async function handleCopy() {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(snippet);
      } else {
        const ta = document.createElement('textarea');
        ta.value = snippet;
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
    } catch { /* silent */ }
  }

  const tabBtn = (id: TabId, label: string) => (
    <button
      key={id}
      type="button"
      role="tab"
      aria-selected={active === id}
      data-testid={`install-tab-${id}`}
      onClick={() => { setActive(id); setCopied(false); }}
      style={{
        padding: '9px 16px',
        fontSize: 13,
        fontWeight: active === id ? 700 : 500,
        border: 'none',
        background: 'transparent',
        color: active === id ? INK : MUTED,
        borderBottom: active === id ? `2px solid ${ACCENT}` : '2px solid transparent',
        marginBottom: -1,
        cursor: 'pointer',
        fontFamily: 'inherit',
        whiteSpace: 'nowrap' as const,
      }}
    >{label}</button>
  );

  return (
    <div style={{ border: `1px solid ${LINE}`, borderRadius: 12, background: CARD, overflow: 'hidden' }}>
      {/* Tab bar */}
      <div role="tablist" style={{ display: 'flex', borderBottom: `1px solid ${LINE}`, background: BG, padding: '0 4px' }}>
        {tabBtn('mcp', 'MCP server')}
        {tabBtn('cli', 'CLI')}
      </div>

      {/* Snippet area */}
      <div style={{ padding: '16px 18px' }}>
        {active === 'mcp' && (
          <p style={{ fontSize: 12, color: MUTED, margin: '0 0 10px', lineHeight: 1.5 }}>
            Works with any MCP client.
          </p>
        )}
        {active === 'cli' && (
          <p style={{ fontSize: 12, color: MUTED, margin: '0 0 10px', lineHeight: 1.5 }}>
            Install the Floom CLI and authenticate with your token.
          </p>
        )}
        {/* F7: light tinted bg on copy boxes (Federico-locked global rule). */}
        <div style={{ position: 'relative' }}>
          <pre style={{ fontFamily: MONO, fontSize: 12, background: 'var(--studio, #f5f4f0)', color: INK, border: `1px solid ${LINE}`, borderRadius: 8, padding: '14px 16px', overflowX: 'auto', whiteSpace: 'pre', lineHeight: 1.6, margin: 0, paddingRight: 80 }}>
            {snippet}
          </pre>
          <button
            type="button"
            data-testid={`copy-install-${active}`}
            onClick={() => void handleCopy()}
            style={{
              position: 'absolute',
              top: 10,
              right: 10,
              fontSize: 11,
              fontWeight: 600,
              color: copied ? MUTED : ACCENT,
              background: '#fff',
              border: `1px solid ${copied ? LINE : 'rgba(4,120,87,0.35)'}`,
              borderRadius: 6,
              padding: '3px 10px',
              cursor: 'pointer',
              fontFamily: 'inherit',
              letterSpacing: '0.03em',
            }}
            aria-label={copied ? 'Copied' : 'Copy install snippet'}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- TokenCard ----------

function TokenCard({ onTokenReady }: { onTokenReady?: (rawToken: string) => void }) {
  const { data: session } = useSession();
  const workspace = session?.active_workspace;
  const [tokens, setTokens] = useState<api.AgentTokenRecord[] | null>(null);
  const [minting, setMinting] = useState(false);
  const [minted, setMinted] = useState<CreatedAgentToken | null>(null);
  const [rotating, setRotating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (!workspace) return;
    try {
      const list = await api.listWorkspaceAgentTokens(workspace.id);
      setTokens(list.filter(t => !t.revoked));
    } catch {
      setTokens([]);
    }
  }

  useEffect(() => { void load(); }, [workspace?.id]);

  async function handleMint() {
    if (!workspace) return;
    setMinting(true);
    setError(null);
    try {
      const created = await api.createWorkspaceAgentToken(workspace.id, { label: 'default', scope: 'read-write' });
      setMinted(created);
      // Notify parent so install snippets update immediately with the real token
      if (created.raw_token) onTokenReady?.(created.raw_token);
      await load();
    } catch (err) {
      setError((err as Error).message || 'Failed to mint token');
    } finally {
      setMinting(false);
    }
  }

  async function handleRotate() {
    if (!workspace || !tokens?.length) return;
    setRotating(true);
    setError(null);
    try {
      // Revoke all existing, then mint fresh
      for (const t of tokens) {
        await api.revokeWorkspaceAgentToken(workspace.id, t.id);
      }
      const created = await api.createWorkspaceAgentToken(workspace.id, { label: 'default', scope: 'read-write' });
      setMinted(created);
      // Notify parent so install snippets update immediately with the real token
      if (created.raw_token) onTokenReady?.(created.raw_token);
      await load();
    } catch (err) {
      setError((err as Error).message || 'Failed to rotate token');
    } finally {
      setRotating(false);
    }
  }

  async function handleCopyToken(tok: string) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(tok);
      } else {
        const ta = document.createElement('textarea');
        ta.value = tok;
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
    } catch { /* silent */ }
  }

  const activeToken = tokens?.[0] ?? null;
  const displayToken = minted?.raw_token ?? null;

  return (
    <div style={{ border: `1px solid ${LINE}`, borderRadius: 12, background: CARD, padding: '22px 24px' }}>
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase' as const, color: ACCENT, margin: '0 0 8px' }}>
          Your agent token
        </h2>
        <p style={{ fontSize: 13, color: MUTED, margin: 0, lineHeight: 1.5 }}>
          Workspace credential. Use with MCP, CLI, or HTTP.
        </p>
      </div>

      {error && (
        <div style={{ background: '#fdecea', border: '1px solid #f4b7b1', color: '#c2321f', borderRadius: 8, padding: '10px 12px', fontSize: 13, marginBottom: 14 }}>
          {error}
        </div>
      )}

      {/* One-time display of freshly minted/rotated token */}
      {displayToken && (
        <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 10, padding: '14px 16px', marginBottom: 16 }}>
          <p style={{ fontSize: 12, color: '#166534', margin: '0 0 8px', fontWeight: 600 }}>
            Copy this token now — it won't be shown again.
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <code style={{ fontFamily: MONO, fontSize: 12.5, background: 'var(--studio, #f5f4f0)', color: INK, border: `1px solid ${LINE}`, padding: '8px 12px', borderRadius: 6, flex: 1, overflowX: 'auto', wordBreak: 'break-all' as const }}>
              {displayToken}
            </code>
            <button
              type="button"
              onClick={() => void handleCopyToken(displayToken)}
              data-testid="copy-token"
              style={{ flexShrink: 0, fontSize: 12, fontWeight: 600, color: '#166534', background: '#dcfce7', border: '1px solid #bbf7d0', borderRadius: 6, padding: '6px 12px', cursor: 'pointer', fontFamily: 'inherit' }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <button type="button" onClick={() => setMinted(null)} style={{ marginTop: 10, fontSize: 12, color: MUTED, background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: 'inherit', padding: 0 }}>
            Done, I've saved it
          </button>
        </div>
      )}

      {tokens === null ? (
        <div style={{ color: MUTED, fontSize: 13, padding: '8px 0' }}>Loading...</div>
      ) : activeToken ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' as const }}>
          <code style={{ fontFamily: MONO, fontSize: 13, background: '#f4f4f2', border: `1px solid ${LINE}`, padding: '8px 14px', borderRadius: 8, color: INK, flex: '1 1 200px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
            floom_agent_••••••••
          </code>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={() => void handleRotate()}
              disabled={rotating}
              data-testid="rotate-token"
              style={{ fontSize: 13, fontWeight: 600, color: MUTED, background: BG, border: `1px solid ${LINE}`, borderRadius: 8, padding: '8px 14px', cursor: rotating ? 'not-allowed' : 'pointer', fontFamily: 'inherit', opacity: rotating ? 0.6 : 1 }}
            >
              {rotating ? 'Rotating...' : 'Rotate'}
            </button>
          </div>
        </div>
      ) : (
        <div style={{ textAlign: 'center' as const, padding: '16px 0 8px' }}>
          <p style={{ fontSize: 13, color: MUTED, margin: '0 0 16px', lineHeight: 1.5 }}>
            No token yet. Mint your workspace credential to connect from any MCP client or CLI.
          </p>
          <button
            type="button"
            onClick={() => void handleMint()}
            disabled={minting}
            data-testid="mint-token"
            style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '11px 24px', borderRadius: 999, background: INK, color: '#fff', fontSize: 14, fontWeight: 700, cursor: minting ? 'not-allowed' : 'pointer', border: 'none', fontFamily: 'inherit', opacity: minting ? 0.7 : 1 }}
          >
            {minting ? 'Minting...' : 'Mint your token'}
          </button>
        </div>
      )}
    </div>
  );
}

// ---------- TestItSection ----------

const TEST_PROMPT = 'use the floom MCP server to generate a uuid';

function TestItSection() {
  const [copied, setCopied] = useState(false);
  async function handleCopy() {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(TEST_PROMPT);
      } else {
        const ta = document.createElement('textarea');
        ta.value = TEST_PROMPT;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch { /* silent */ }
  }

  const steps = [
    {
      num: '1',
      title: 'Paste your MCP config',
      body: (
        <>
          Open{' '}
          <code style={{ fontFamily: MONO, fontSize: 12, background: '#f4f4f2', padding: '1px 5px', borderRadius: 4 }}>
            ~/Library/Application Support/Claude/claude_desktop_config.json
          </code>{' '}
          and paste the MCP config from the Install tab above.
        </>
      ),
    },
    {
      num: '2',
      title: 'Restart Claude Desktop',
      body: 'Quit and reopen Claude Desktop so it picks up the new MCP server.',
    },
    {
      num: '3',
      title: 'Ask Claude to test it',
      body: (
        <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 8, width: '100%' }}>
          <code
            data-testid="test-prompt-text"
            style={{ fontFamily: MONO, fontSize: 12, background: 'var(--studio, #f5f4f0)', color: INK, border: `1px solid ${LINE}`, padding: '8px 12px', borderRadius: 6, flex: 1 }}
          >
            {TEST_PROMPT}
          </code>
          <button
            type="button"
            data-testid="test-prompt-copy-btn"
            onClick={() => void handleCopy()}
            style={{
              flexShrink: 0,
              fontSize: 12,
              fontWeight: 600,
              color: copied ? MUTED : ACCENT,
              background: BG,
              border: `1px solid ${LINE}`,
              borderRadius: 6,
              padding: '6px 12px',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      ),
    },
  ];

  return (
    <div style={{ border: `1px solid ${LINE}`, borderRadius: 12, background: CARD, padding: '22px 24px' }}>
      <h2 style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase' as const, color: ACCENT, margin: '0 0 16px' }}>
        Test it in 3 steps
      </h2>
      <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 16 }}>
        {steps.map((s) => (
          <div key={s.num} style={{ display: 'flex', gap: 14 }}>
            <div style={{
              flexShrink: 0,
              width: 24,
              height: 24,
              borderRadius: '50%',
              background: ACCENT,
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 11,
              fontWeight: 700,
              fontFamily: MONO,
              marginTop: 2,
            }}>
              {s.num}
            </div>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, color: INK, marginBottom: 4 }}>{s.title}</div>
              <div style={{ fontSize: 13, color: MUTED, lineHeight: 1.55 }}>{s.body}</div>
            </div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 20, paddingTop: 20, borderTop: `1px solid ${LINE}` }}>
        <p style={{ fontSize: 12, color: MUTED, margin: '0 0 10px', fontWeight: 600 }}>Alternative: use the HTTP API directly</p>
        <pre style={{ fontFamily: MONO, fontSize: 11.5, background: 'var(--studio, #f5f4f0)', color: INK, border: `1px solid ${LINE}`, borderRadius: 8, padding: '12px 14px', overflowX: 'auto', whiteSpace: 'pre', lineHeight: 1.6, margin: 0 }}>
          {`curl -X POST https://floom.dev/api/uuid/run \\
  -H 'Authorization: Bearer floom_agent_<your_token>'`}
        </pre>
      </div>
    </div>
  );
}

// ---------- HomeHero ----------
//
// R7.5 (2026-04-28): /home redesign — Federico's brief: "make it sexier".
// Adds a hero-y greeting at the top: name + outcome line, plus a thin
// ambient status row (workspace · token state · agent reachability) so
// the page feels alive instead of inert.

function HomeHero({ name, hasToken }: { name: string; hasToken: boolean }) {
  // Time-of-day greeting. Cheap, ambient, doesn't fake intelligence.
  const hour = new Date().getHours();
  const tod =
    hour < 5 ? 'late shift' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';

  return (
    <header
      style={{
        marginBottom: 28,
      }}
    >
      <p
        data-testid="home-eyebrow"
        style={{
          fontFamily: MONO,
          fontSize: 10.5,
          fontWeight: 700,
          letterSpacing: '0.12em',
          textTransform: 'uppercase' as const,
          color: ACCENT,
          margin: '0 0 10px',
        }}
      >
        Good {tod}, {name}
      </p>
      <h1
        style={{
          fontFamily: 'var(--font-display, Inter), system-ui, sans-serif',
          fontSize: 32,
          fontWeight: 800,
          letterSpacing: '-0.025em',
          color: INK,
          margin: '0 0 10px',
          lineHeight: 1.1,
        }}
      >
        {hasToken ? "You're in. Connect any agent." : "You're in. Mint a token to connect any agent."}
      </h1>
      <p
        style={{
          fontSize: 15,
          color: MUTED,
          margin: 0,
          lineHeight: 1.55,
          maxWidth: 540,
        }}
      >
        One token, every MCP client + the HTTP API. No SDKs to install, no per-app keys.
      </p>
    </header>
  );
}

function AmbientStatus({
  workspaceName,
  hasToken,
}: {
  workspaceName: string | null;
  hasToken: boolean;
}) {
  const dot = (color: string) => (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-block',
        width: 7,
        height: 7,
        borderRadius: '50%',
        background: color,
        flexShrink: 0,
      }}
    />
  );
  const cell: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 7,
    fontSize: 12,
    color: MUTED,
    fontFamily: MONO,
  };
  return (
    <div
      data-testid="home-ambient-status"
      style={{
        display: 'flex',
        flexWrap: 'wrap' as const,
        gap: 18,
        rowGap: 8,
        padding: '10px 14px',
        background: 'var(--studio, #f5f4f0)',
        border: `1px solid ${LINE}`,
        borderRadius: 10,
        marginBottom: 24,
      }}
    >
      <span style={cell}>
        {dot(ACCENT)}
        workspace · {workspaceName ?? 'loading'}
      </span>
      <span style={cell}>
        {dot(hasToken ? ACCENT : '#e0a93b')}
        token · {hasToken ? 'active' : 'not minted'}
      </span>
      <span style={cell}>
        {dot(ACCENT)}
        api · {HOST_ORIGIN.replace(/^https?:\/\//, '')}
      </span>
    </div>
  );
}

// ---------- MvpHomePage ----------

export function MvpHomePage() {
  const { data: session, isAuthenticated } = useSession();
  const workspace = session?.active_workspace;
  const navigate = useNavigate();
  const [tokens, setTokens] = useState<api.AgentTokenRecord[] | null>(null);
  // Holds the most recently minted raw token so InstallTabs shows real value
  // immediately on mint without requiring a page refresh (#911).
  const [liveRawToken, setLiveRawToken] = useState<string | null>(null);
  // R7.5: brief animated feedback on mint — Federico's "animated mint
  // feedback on token creation".
  const [mintFlash, setMintFlash] = useState(false);

  // Load tokens to know whether any token exists (to show/hide InstallTabs)
  useEffect(() => {
    if (!workspace) return;
    api.listWorkspaceAgentTokens(workspace.id)
      .then(list => setTokens(list.filter(t => !t.revoked)))
      .catch(() => setTokens([]));
  }, [workspace?.id]);

  // Redirect unauthenticated users to login
  useEffect(() => {
    if (isAuthenticated === false) navigate('/login', { replace: true });
  }, [isAuthenticated, navigate]);

  const hasToken = tokens !== null && tokens.length > 0;
  // After minting, use the live raw token in snippets. Fall back to masked
  // placeholder once token exists but the raw value is no longer in state
  // (e.g. after page reload — the user has to rotate to see a new raw token).
  const installToken = liveRawToken ?? (hasToken ? 'floom_agent_••••••••' : '');

  // Pull a sane greeting label from the session.
  const user = session?.user;
  const greetingName = (user?.name?.split(' ')[0] || user?.email?.split('@')[0] || 'builder');

  return (
    <div style={{ minHeight: '100vh', background: BG, display: 'flex', flexDirection: 'column', fontFamily: "'Inter', system-ui, sans-serif" }}>
      <TopBar />
      <main style={{ flex: 1 }}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '48px 24px 64px' }}>
        <HomeHero name={greetingName} hasToken={hasToken || liveRawToken !== null} />
        <AmbientStatus
          workspaceName={workspace?.name ?? null}
          hasToken={hasToken || liveRawToken !== null}
        />
        <div
          style={{
            // Ambient mint flash — green outer ring fades after 1.5s.
            transition: 'box-shadow 0.6s ease-out',
            boxShadow: mintFlash ? `0 0 0 4px rgba(4,120,87,0.18)` : '0 0 0 0 transparent',
            borderRadius: 12,
          }}
        >
          <TokenCard onTokenReady={(raw) => {
            setLiveRawToken(raw);
            setMintFlash(true);
            window.setTimeout(() => setMintFlash(false), 1600);
            // Ensure token list reflects the newly minted token
            if (workspace) {
              api.listWorkspaceAgentTokens(workspace.id)
                .then(list => setTokens(list.filter(t => !t.revoked)))
                .catch(() => {});
            }
          }} />
        </div>

        <h2 style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase' as const, color: INK, margin: '36px 0 12px' }}>
          Install
        </h2>
        {hasToken || liveRawToken ? (
          <InstallTabs token={installToken} />
        ) : (
          <div
            data-testid="install-no-token"
            style={{
              border: `1px solid ${LINE}`,
              borderRadius: 12,
              background: CARD,
              padding: '28px 24px',
              textAlign: 'center' as const,
              opacity: 0.6,
            }}
          >
            <p style={{ fontSize: 13, color: MUTED, margin: 0, lineHeight: 1.6 }}>
              Mint your first token above to see the install snippet.
            </p>
          </div>
        )}

        <div style={{ marginTop: 24 }}>
          <TestItSection />
        </div>
      </div>
      </main>
      <PublicFooter />
    </div>
  );
}
