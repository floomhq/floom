// MVP: /me — user dashboard.
//
// v11-faithful sidebar shell with 8 items across 3 sections:
//   Personal:  Your apps (real → runs), Folders*, Saved results*,
//              Schedules*, My tickets*
//   Workspace: Shared with me*
//   More:      Browse the store (link → /apps), Install to Claude (real)
//
// Items marked * render a ComingSoonStub. Every real tab reads from a real
// endpoint, no mocks. Empty states have real icons + CTAs.
//
// The Connected tools tab (Composio OAuth to 150+ tools) is deferred and
// is NOT listed as coming-soon per the MVP scope — see docs/DEFERRED-UI.md
// and feature/ui-composio-connections. Backend /api/connections routes
// stay live on main.

import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { PageShell } from '../components/PageShell';
import { useSession } from '../hooks/useSession';
import * as api from '../api/client';
import type { MeRunSummary, SessionMePayload } from '../lib/types';

type Tab =
  | 'your-apps'
  | 'folders'
  | 'saved-results'
  | 'schedules'
  | 'my-tickets'
  | 'shared'
  | 'install';

type SidebarItem =
  | { kind: 'tab'; id: Tab; label: string; icon: ReactNode }
  | { kind: 'link'; href: string; label: string; icon: ReactNode };

type SidebarSection = { label: string; items: SidebarItem[] };

function buildSidebar(): SidebarSection[] {
  return [
    {
      label: 'Personal',
      items: [
        { kind: 'tab', id: 'your-apps', label: 'Your apps', icon: <IconPackage /> },
        { kind: 'tab', id: 'folders', label: 'Folders', icon: <IconLayers /> },
        { kind: 'tab', id: 'saved-results', label: 'Saved results', icon: <IconBookmark /> },
        { kind: 'tab', id: 'schedules', label: 'Schedules', icon: <IconClock /> },
        { kind: 'tab', id: 'my-tickets', label: 'My tickets', icon: <IconInbox /> },
      ],
    },
    {
      label: 'Workspace',
      items: [
        { kind: 'tab', id: 'shared', label: 'Shared with me', icon: <IconUsers /> },
      ],
    },
    {
      label: 'More',
      items: [
        { kind: 'link', href: '/apps', label: 'Browse the store', icon: <IconCompass /> },
        { kind: 'tab', id: 'install', label: 'Install to Claude', icon: <IconDownload /> },
      ],
    },
  ];
}

export function MePage() {
  const { data: session, isAuthenticated } = useSession();
  const [tab, setTab] = useState<Tab>('your-apps');
  const sidebar = buildSidebar();

  return (
    <PageShell requireAuth="cloud" title="My dashboard | Floom">
      <div data-testid="me-page">
        <div style={{ marginBottom: 28 }}>
          <h1
            className="section-title-display"
            style={{ fontSize: 36, margin: '0 0 6px' }}
          >
            My dashboard
          </h1>
          <p style={{ fontSize: 14, color: 'var(--muted)', margin: 0 }}>
            {isAuthenticated
              ? `Signed in as ${session?.user.email || session?.user.name}`
              : 'Local mode. Your runs are scoped to this device.'}
          </p>
        </div>

        <div className="me-layout">
          <aside className="me-sidebar" aria-label="Dashboard navigation">
            {sidebar.map((section) => (
              <div key={section.label} className="me-sidebar-section">
                <div className="me-sidebar-label">{section.label}</div>
                {section.items.map((item) => {
                  if (item.kind === 'link') {
                    return (
                      <Link
                        key={item.href}
                        to={item.href}
                        className="me-sidebar-item"
                        data-testid={`me-nav-${item.label.toLowerCase().replace(/\s+/g, '-')}`}
                      >
                        <span className="me-sidebar-icon">{item.icon}</span>
                        <span>{item.label}</span>
                      </Link>
                    );
                  }
                  const isActive = tab === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setTab(item.id)}
                      className={`me-sidebar-item${isActive ? ' active' : ''}`}
                      data-testid={`me-nav-${item.id}`}
                      aria-current={isActive ? 'page' : undefined}
                    >
                      <span className="me-sidebar-icon">{item.icon}</span>
                      <span>{item.label}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </aside>

          <div className="me-main">
            {tab === 'your-apps' && <RunsTab />}
            {tab === 'folders' && (
              <ComingSoonStub
                title="Folders"
                description="Organize your apps and runs into folders. Coming in the next release."
                cta={{ label: 'Browse apps', to: '/apps' }}
                testId="stub-folders"
              />
            )}
            {tab === 'saved-results' && (
              <ComingSoonStub
                title="Saved results"
                description="Pin run outputs you want to keep. Coming in the next release."
                cta={{ label: 'View your runs', onClick: () => setTab('your-apps') }}
                testId="stub-saved-results"
              />
            )}
            {tab === 'schedules' && (
              <ComingSoonStub
                title="Schedules"
                description="Run Floom apps on a cron or webhook. Coming in the next release. For now, run your apps manually from the store."
                cta={{ label: 'Browse apps', to: '/apps' }}
                testId="stub-schedules"
              />
            )}
            {tab === 'my-tickets' && (
              <ComingSoonStub
                title="My tickets"
                description="Support inbox for your Floom apps. Coming in the next release."
                cta={{ label: 'Open feedback', href: 'mailto:team@floom.dev' }}
                testId="stub-my-tickets"
              />
            )}
            {tab === 'shared' && (
              <ComingSoonStub
                title="Shared with me"
                description="Apps and runs other Floom users have shared with you. Coming in the next release."
                cta={{ label: 'Browse public apps', to: '/apps' }}
                testId="stub-shared"
              />
            )}
            {tab === 'install' && <InstallTab session={session} />}
          </div>
        </div>
      </div>
    </PageShell>
  );
}

// ---------- Coming soon stub ----------
interface StubCta {
  label: string;
  to?: string;
  href?: string;
  onClick?: () => void;
}

function ComingSoonStub({
  title,
  description,
  cta,
  testId,
}: {
  title: string;
  description: string;
  cta: StubCta;
  testId: string;
}) {
  return (
    <div
      data-testid={testId}
      style={{
        border: '1px solid var(--line)',
        background: 'var(--card)',
        borderRadius: 12,
        padding: '48px 32px',
        textAlign: 'center',
        maxWidth: 520,
      }}
    >
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 10px',
          borderRadius: 999,
          background: 'var(--accent-soft)',
          color: 'var(--accent)',
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          marginBottom: 16,
        }}
      >
        Coming soon
      </div>
      <h2
        style={{
          fontSize: 22,
          fontWeight: 700,
          margin: '0 0 10px',
          color: 'var(--ink)',
        }}
      >
        {title}
      </h2>
      <p
        style={{
          fontSize: 14,
          color: 'var(--muted)',
          margin: '0 auto 24px',
          maxWidth: 420,
          lineHeight: 1.6,
        }}
      >
        {description}
      </p>
      {cta.to ? (
        <Link
          to={cta.to}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '10px 20px',
            background: 'var(--accent)',
            color: '#fff',
            borderRadius: 8,
            fontSize: 14,
            fontWeight: 600,
            textDecoration: 'none',
          }}
        >
          {cta.label}
        </Link>
      ) : cta.href ? (
        <a
          href={cta.href}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '10px 20px',
            background: 'var(--accent)',
            color: '#fff',
            borderRadius: 8,
            fontSize: 14,
            fontWeight: 600,
            textDecoration: 'none',
          }}
        >
          {cta.label}
        </a>
      ) : (
        <button
          type="button"
          onClick={cta.onClick}
          style={{
            padding: '10px 20px',
            background: 'var(--accent)',
            color: '#fff',
            border: 'none',
            borderRadius: 8,
            fontSize: 14,
            fontWeight: 600,
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          {cta.label}
        </button>
      )}
    </div>
  );
}

// ---------- Sidebar icons (inline SVG, stroke-based) ----------
function IconPackage() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M16.5 9.4 7.55 4.24" /><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" /><path d="m3.27 6.96 8.73 5.05 8.73-5.05" /><path d="M12 22.08V12" />
    </svg>
  );
}
function IconLayers() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polygon points="12 2 2 7 12 12 22 7 12 2" /><polyline points="2 17 12 22 22 17" /><polyline points="2 12 12 17 22 12" />
    </svg>
  );
}
function IconBookmark() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z" />
    </svg>
  );
}
function IconClock() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
    </svg>
  );
}
function IconInbox() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
  );
}
function IconUsers() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}
function IconCompass() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" /><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
    </svg>
  );
}
function IconDownload() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
    </svg>
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

// ---------- Install tab ----------
function InstallTab({ session: _session }: { session: SessionMePayload | null }) {
  const origin =
    typeof window !== 'undefined' ? window.location.origin : 'https://preview.floom.dev';

  // /mcp/search is the gallery-wide search endpoint that lets the agent
  // discover any Floom app by natural language, then call it via its own
  // /mcp/app/:slug endpoint.
  const mcpUrl = `${origin}/mcp/search`;

  // Claude Desktop's stable config format only accepts stdio servers with
  // `command`/`args`. For remote HTTP MCP we wrap the URL with `mcp-remote`
  // (the official Anthropic HTTP bridge). Use flyfast as a worked example so
  // users can see how to add any app.
  const claudeConfig = JSON.stringify(
    {
      mcpServers: {
        'floom-search': {
          command: 'npx',
          args: ['-y', 'mcp-remote', `${origin}/mcp/search`],
        },
        'floom-flyfast': {
          command: 'npx',
          args: ['-y', 'mcp-remote', `${origin}/mcp/app/flyfast`],
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
