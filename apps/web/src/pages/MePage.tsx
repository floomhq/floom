// W4-minimal: /me — user dashboard.
//
// Three tabs (or stacked sections on mobile): My runs, My connections,
// Install to Claude Desktop. Every tab reads from a real endpoint — no
// mocks. Empty states have real icons + CTAs.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageShell } from '../components/PageShell';
import { useSession } from '../hooks/useSession';
import * as api from '../api/client';
import type { MeRunSummary, ConnectionRecord, SessionMePayload } from '../lib/types';

type Tab = 'runs' | 'connections' | 'install';

export function MePage() {
  const { data: session, isAuthenticated } = useSession();
  const [tab, setTab] = useState<Tab>('runs');

  // Gated page (any session works; cloud requires login — PageShell handles).
  return (
    <PageShell requireAuth="cloud" title="My dashboard | Floom">
      <div data-testid="me-page">
        <div style={{ marginBottom: 32 }}>
          <h1
            style={{
              fontSize: 28,
              fontWeight: 700,
              margin: '0 0 6px',
              color: 'var(--ink)',
            }}
          >
            My dashboard
          </h1>
          <p style={{ fontSize: 14, color: 'var(--muted)', margin: 0 }}>
            {isAuthenticated
              ? `Signed in as ${session?.user.email || session?.user.name}`
              : 'Local mode — your runs are scoped to this device.'}
          </p>
        </div>

        <div
          role="tablist"
          style={{
            display: 'flex',
            gap: 0,
            borderBottom: '2px solid var(--line)',
            marginBottom: 28,
            overflowX: 'auto',
          }}
        >
          {(
            [
              { id: 'runs', label: 'My runs' },
              { id: 'connections', label: 'My connections' },
              { id: 'install', label: 'Install' },
            ] as Array<{ id: Tab; label: string }>
          ).map(({ id, label }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              data-testid={`me-tab-${id}`}
              style={{
                padding: '10px 20px',
                background: 'none',
                border: 'none',
                borderBottom: tab === id ? '2px solid var(--accent)' : '2px solid transparent',
                marginBottom: -2,
                fontSize: 14,
                fontWeight: tab === id ? 600 : 500,
                color: tab === id ? 'var(--ink)' : 'var(--muted)',
                cursor: 'pointer',
                fontFamily: 'inherit',
                whiteSpace: 'nowrap',
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === 'runs' && <RunsTab />}
        {tab === 'connections' && <ConnectionsTab />}
        {tab === 'install' && <InstallTab session={session} />}
      </div>
    </PageShell>
  );
}

// ---------- Runs tab ----------
function RunsTab() {
  const [runs, setRuns] = useState<MeRunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getMyRuns(50)
      .then((res) => setRuns(res.runs))
      .catch((err) => setError((err as Error).message));
  }, []);

  if (error) {
    return (
      <ErrorCard
        title="Couldn't load your runs"
        message={error}
        data-testid="runs-error"
      />
    );
  }
  if (!runs) {
    return <SkeletonList />;
  }
  if (runs.length === 0) {
    return (
      <EmptyState
        icon={<RunIcon />}
        title="No runs yet"
        description="Run your first app from the store."
        cta={{ label: 'Browse apps', to: '/apps' }}
        testId="runs-empty"
      />
    );
  }

  return (
    <div
      data-testid="runs-list"
      style={{
        border: '1px solid var(--line)',
        borderRadius: 12,
        background: 'var(--card)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '2fr 1fr 1fr 1fr 80px',
          gap: 8,
          padding: '12px 18px',
          fontSize: 11,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: 'var(--muted)',
          fontWeight: 700,
          borderBottom: '1px solid var(--line)',
          background: 'var(--bg)',
        }}
      >
        <span>App</span>
        <span>Action</span>
        <span>Status</span>
        <span>Started</span>
        <span style={{ textAlign: 'right' }}>Time</span>
      </div>
      {runs.map((r) => (
        <Link
          key={r.id}
          to={`/me/runs/${r.id}`}
          style={{
            display: 'grid',
            gridTemplateColumns: '2fr 1fr 1fr 1fr 80px',
            gap: 8,
            padding: '14px 18px',
            borderBottom: '1px solid var(--line)',
            fontSize: 13,
            color: 'var(--ink)',
            textDecoration: 'none',
            alignItems: 'center',
          }}
          data-testid={`run-row-${r.id}`}
        >
          <span style={{ fontWeight: 600 }}>{r.app_name || r.app_slug || '(unknown)'}</span>
          <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12, color: 'var(--muted)' }}>
            {r.action}
          </span>
          <StatusPill status={r.status} />
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>{formatTime(r.started_at)}</span>
          <span style={{ textAlign: 'right', color: 'var(--muted)', fontSize: 12 }}>
            {r.duration_ms ? `${Math.round(r.duration_ms)}ms` : '-'}
          </span>
        </Link>
      ))}
    </div>
  );
}

// ---------- Connections tab ----------
function ConnectionsTab() {
  const [connections, setConnections] = useState<ConnectionRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    try {
      const res = await api.listConnections();
      setConnections(res.connections);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function connect(provider: string) {
    setBusy(provider);
    try {
      const res = await api.initiateConnection(provider);
      window.open(res.auth_url, '_blank', 'width=560,height=720');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function disconnect(provider: string) {
    if (!confirm(`Disconnect ${provider}?`)) return;
    setBusy(provider);
    try {
      await api.revokeConnectionApi(provider);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (error) {
    return <ErrorCard title="Couldn't load connections" message={error} />;
  }
  if (!connections) {
    return <SkeletonList />;
  }

  const active = connections.filter((c) => c.status === 'active');

  return (
    <div data-testid="connections-list">
      {active.length === 0 ? (
        <EmptyState
          icon={<ConnectIcon />}
          title="No tools connected"
          description="Connect Gmail, Slack, Notion, or any of 150+ tools. Connected apps show up inside Floom apps that need them."
          cta={{ label: 'Connect Gmail', onClick: () => connect('gmail') }}
          testId="connections-empty"
        />
      ) : (
        <>
          <div
            style={{
              border: '1px solid var(--line)',
              borderRadius: 12,
              background: 'var(--card)',
              overflow: 'hidden',
              marginBottom: 16,
            }}
          >
            {active.map((c) => (
              <div
                key={c.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 14,
                  padding: '14px 18px',
                  borderBottom: '1px solid var(--line)',
                }}
                data-testid={`connection-${c.provider}`}
              >
                <div
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 6,
                    background: 'var(--bg)',
                    border: '1px solid var(--line)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 13,
                    fontWeight: 700,
                    color: 'var(--ink)',
                    textTransform: 'uppercase',
                  }}
                >
                  {c.provider.charAt(0)}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>
                    {c.provider}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                    Connected {formatTime(c.created_at)}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => disconnect(c.provider)}
                  disabled={busy === c.provider}
                  style={{
                    padding: '6px 12px',
                    background: 'transparent',
                    border: '1px solid var(--line)',
                    borderRadius: 6,
                    fontSize: 12,
                    color: 'var(--muted)',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  {busy === c.provider ? '...' : 'Disconnect'}
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      <div style={{ marginTop: 24 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, color: 'var(--muted)', margin: '0 0 12px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Connect a new tool
        </h3>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
            gap: 12,
          }}
        >
          {['gmail', 'slack', 'notion', 'github', 'googlesheets', 'linear'].map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => connect(p)}
              disabled={busy === p}
              data-testid={`connect-${p}`}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                gap: 6,
                padding: '14px 16px',
                background: 'var(--card)',
                border: '1px solid var(--line)',
                borderRadius: 10,
                fontSize: 13,
                color: 'var(--ink)',
                fontFamily: 'inherit',
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <span style={{ fontWeight: 600, textTransform: 'capitalize' }}>{p}</span>
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                {busy === p ? 'Starting...' : 'Connect'}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------- Install tab ----------
function InstallTab({ session }: { session: SessionMePayload | null }) {
  const origin =
    typeof window !== 'undefined' ? window.location.origin : 'https://preview.floom.dev';

  const mcpUrl = `${origin}/mcp`;
  const userId = session?.user.is_local ? 'local' : session?.user.id || 'local';

  const claudeConfig = JSON.stringify(
    {
      mcpServers: {
        floom: {
          url: `${origin}/mcp/app/flyfast`,
          headers: {
            'X-Floom-User': userId,
          },
        },
      },
    },
    null,
    2,
  );

  return (
    <div data-testid="install-tab" style={{ maxWidth: 680 }}>
      <h2 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 8px', color: 'var(--ink)' }}>
        Install to Claude Desktop
      </h2>
      <p style={{ fontSize: 14, color: 'var(--muted)', margin: '0 0 24px', lineHeight: 1.6 }}>
        Paste this into your <code style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12, background: 'var(--bg)', padding: '2px 6px', borderRadius: 4 }}>claude_desktop_config.json</code> and restart Claude Desktop.
      </p>

      <div
        style={{
          background: 'var(--card)',
          border: '1px solid var(--line)',
          borderRadius: 12,
          padding: '16px 20px',
          marginBottom: 16,
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Step 1 — MCP URL
        </div>
        <CopyRow value={mcpUrl} />
      </div>

      <div
        style={{
          background: 'var(--card)',
          border: '1px solid var(--line)',
          borderRadius: 12,
          padding: '16px 20px',
          marginBottom: 16,
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Step 2 — Paste into config
        </div>
        <CodeBlock code={claudeConfig} />
      </div>

      <div
        style={{
          background: 'var(--card)',
          border: '1px solid var(--line)',
          borderRadius: 12,
          padding: '16px 20px',
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Step 3 — Test from HTTP
        </div>
        <CodeBlock
          code={`curl -X POST ${origin}/api/flyfast/run \\
  -H "Content-Type: application/json" \\
  -d '{"action":"search","inputs":{"prompt":"LIS to BER next week"}}'`}
        />
      </div>
    </div>
  );
}

// ---------- shared helpers ----------

function StatusPill({ status }: { status: string }) {
  const colors: Record<string, { bg: string; fg: string }> = {
    success: { bg: '#e6f4ea', fg: '#1a7f37' },
    error: { bg: '#fdecea', fg: '#c2321f' },
    timeout: { bg: '#fdecea', fg: '#c2321f' },
    running: { bg: '#e9e6ff', fg: '#3d2bff' },
    pending: { bg: '#f4f4f0', fg: '#585550' },
  };
  const c = colors[status] || colors.pending;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 8px',
        background: c.bg,
        color: c.fg,
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        width: 'fit-content',
      }}
    >
      {status}
    </span>
  );
}

export function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.floor(hr / 24);
    if (day < 7) return `${day}d ago`;
    return d.toLocaleDateString();
  } catch {
    return iso;
  }
}

function SkeletonList() {
  return (
    <div data-testid="skeleton-list">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          style={{
            height: 48,
            background: 'var(--bg)',
            border: '1px solid var(--line)',
            borderRadius: 8,
            marginBottom: 8,
            animation: 'pulse 1.5s infinite',
          }}
        />
      ))}
    </div>
  );
}

function EmptyState({
  icon,
  title,
  description,
  cta,
  testId,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  cta?: { label: string; to?: string; onClick?: () => void };
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      style={{
        textAlign: 'center',
        padding: '56px 24px',
        background: 'var(--card)',
        border: '1px dashed var(--line)',
        borderRadius: 12,
      }}
    >
      <div
        style={{
          width: 56,
          height: 56,
          borderRadius: 14,
          background: 'var(--bg)',
          border: '1px solid var(--line)',
          margin: '0 auto 16px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--muted)',
        }}
      >
        {icon}
      </div>
      <h3 style={{ fontSize: 16, fontWeight: 700, color: 'var(--ink)', margin: '0 0 6px' }}>
        {title}
      </h3>
      <p
        style={{
          fontSize: 13,
          color: 'var(--muted)',
          margin: '0 0 16px',
          maxWidth: 360,
          marginLeft: 'auto',
          marginRight: 'auto',
          lineHeight: 1.55,
        }}
      >
        {description}
      </p>
      {cta &&
        (cta.to ? (
          <Link
            to={cta.to}
            style={{
              display: 'inline-block',
              padding: '9px 16px',
              background: 'var(--ink)',
              color: '#fff',
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 600,
              textDecoration: 'none',
            }}
          >
            {cta.label}
          </Link>
        ) : (
          <button
            type="button"
            onClick={cta.onClick}
            style={{
              padding: '9px 16px',
              background: 'var(--ink)',
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 600,
              fontFamily: 'inherit',
              cursor: 'pointer',
            }}
          >
            {cta.label}
          </button>
        ))}
    </div>
  );
}

function ErrorCard({ title, message }: { title: string; message: string }) {
  return (
    <div
      style={{
        background: '#fff8e6',
        border: '1px solid #f4e0a5',
        borderRadius: 10,
        padding: '14px 18px',
        color: '#755a00',
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 13, fontFamily: 'JetBrains Mono, monospace' }}>{message}</div>
    </div>
  );
}

function CopyRow({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    try {
      void navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // no-op
    }
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <code
        style={{
          flex: 1,
          fontSize: 12,
          fontFamily: 'JetBrains Mono, monospace',
          color: 'var(--ink)',
          background: 'var(--bg)',
          border: '1px solid var(--line)',
          borderRadius: 6,
          padding: '8px 12px',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {value}
      </code>
      <button
        type="button"
        onClick={copy}
        style={{
          padding: '6px 12px',
          background: 'var(--bg)',
          border: '1px solid var(--line)',
          borderRadius: 6,
          fontSize: 11,
          color: copied ? '#1a7f37' : 'var(--muted)',
          cursor: 'pointer',
          fontFamily: 'inherit',
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    try {
      void navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // no-op
    }
  }
  return (
    <div style={{ position: 'relative' }}>
      <pre
        style={{
          background: '#0e0e0c',
          color: '#d4d4c8',
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 12,
          padding: 16,
          borderRadius: 8,
          overflowX: 'auto',
          lineHeight: 1.7,
          margin: 0,
          whiteSpace: 'pre',
        }}
      >
        {code}
      </pre>
      <button
        type="button"
        onClick={copy}
        style={{
          position: 'absolute',
          top: 8,
          right: 8,
          fontSize: 10,
          padding: '3px 8px',
          background: 'rgba(255,255,255,0.1)',
          border: '1px solid rgba(255,255,255,0.15)',
          borderRadius: 4,
          color: copied ? '#7bffc0' : 'rgba(255,255,255,0.5)',
          cursor: 'pointer',
          fontFamily: 'inherit',
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

function RunIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M8 5v14l11-7z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ConnectIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M10 14L4 20M14 10l6-6M6 16h2m8-10h2M7 4v4m10 8v4M4 8l3 2m14 6l-3 2"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
