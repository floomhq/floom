// v17 /install-in-claude — public landing with 4-tab install flow.
// Tab order: Claude Desktop · Claude Code · Cursor · Other MCP client.
// No slug: shows generic install snippets pointing at mcp.floom.dev/search.
// With slug (via InstallAppPage wrapper): pre-fills snippets for that app.
//
// Each tab renders 4 steps + a copy-to-clipboard code block + a
// "Connected" success panel so users know what to look for.

import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PageShell } from '../components/PageShell';
import { useDeployEnabled } from '../lib/flags';

// ── Types ────────────────────────────────────────────────────────────────────

type ClientTab = 'desktop' | 'code' | 'cursor' | 'other';

interface AppMeta {
  slug: string;
  name: string;
  /** Two-letter abbreviation shown in the icon box */
  initials: string;
  /** Tailwind-compatible hex for the icon background */
  iconBg: string;
  /** Text colour inside the icon */
  iconFg: string;
}

interface InstallInClaudePageProps {
  app?: AppMeta;
}

// ── Snippet builders ─────────────────────────────────────────────────────────

const MCP_BASE = 'https://mcp.floom.dev';

// Launch MCP slugs (copy-paste audit): lead-scorer, competitor-analyzer,
// resume-screener → `${MCP_BASE}/app/<slug>` in every tab snippet.

function desktopSnippet(slug: string | null): string {
  const serverKey = slug ?? 'floom';
  const url = slug ? `${MCP_BASE}/app/${slug}` : `${MCP_BASE}/search`;
  return JSON.stringify(
    {
      mcpServers: {
        [serverKey]: {
          url,
        },
      },
    },
    null,
    2,
  );
}

function claudeCodeSnippet(slug: string | null): string {
  const serverName = slug ?? 'floom';
  const url = slug ? `${MCP_BASE}/app/${slug}` : `${MCP_BASE}/search`;
  // `claude mcp add <name> --transport http <url>` — the <name> positional
  // is required; without it Claude Code fails with "missing required
  // argument 'commandOrUrl'".
  return `claude mcp add ${serverName} --transport http ${url}`;
}

function cursorSnippet(slug: string | null): string {
  const serverKey = slug ?? 'floom';
  const url = slug ? `${MCP_BASE}/app/${slug}` : `${MCP_BASE}/search`;
  return JSON.stringify(
    {
      mcpServers: {
        [serverKey]: {
          url,
          transport: 'http',
        },
      },
    },
    null,
    2,
  );
}

function otherSnippet(slug: string | null): string {
  const url = slug ? `${MCP_BASE}/app/${slug}` : `${MCP_BASE}/search`;
  return `MCP endpoint (HTTP/SSE):
${url}

Transport: Streamable HTTP (MCP spec 2025-03-26)
Auth: none required for public apps`;
}

// ── Styles ───────────────────────────────────────────────────────────────────

const v17: Record<string, React.CSSProperties> = {
  surface2: { background: 'var(--surface-2, #f5f4f0)' },
  border: { border: '1px solid var(--border, #eceae4)' },
  monoTag: {
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    fontSize: 10.5,
    fontWeight: 600,
    color: 'var(--muted, #64748b)',
    letterSpacing: '0.08em',
    textTransform: 'uppercase' as const,
    marginBottom: 8,
  },
  stepNum: {
    width: 22,
    height: 22,
    borderRadius: 999,
    background: 'var(--ink, #0f172a)',
    color: '#fff',
    fontSize: 11,
    fontWeight: 700,
    display: 'flex' as const,
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: "'JetBrains Mono', monospace",
    flexShrink: 0,
    marginTop: 2,
  },
  pathTag: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    background: 'var(--surface-2, #f5f4f0)',
    border: '1px solid var(--border, #eceae4)',
    borderRadius: 5,
    padding: '2px 7px',
    color: 'var(--text-2, #334155)',
  },
  callout: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 10.5,
    color: 'var(--muted, #64748b)',
    background: '#fff',
    border: '1px dashed var(--border-hover, #c4c1b8)',
    borderRadius: 8,
    padding: '6px 10px',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    lineHeight: 1.4,
    marginTop: 8,
  } as React.CSSProperties,
};

// ── CopyButton ────────────────────────────────────────────────────────────────

function CopyButton({ text, style }: { text: string; style?: React.CSSProperties }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    try {
      void navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* no-op */
    }
  }
  return (
    <button
      type="button"
      onClick={copy}
      style={{
        background: '#26241f',
        color: copied ? 'var(--accent,#047857)' : '#c7c3b8',
        border: '1px solid #3a3731',
        borderRadius: 7,
        padding: '5px 10px',
        fontSize: 11,
        cursor: 'pointer',
        fontFamily: "'JetBrains Mono', monospace",
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        ...style,
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

// ── CodeBlock ─────────────────────────────────────────────────────────────────

function CodeBlock({ code }: { code: string }) {
  return (
    <div style={{ position: 'relative' }}>
      <pre
        style={{
          // Warm dark neutral — no pure black on terminal surfaces.
          // Same token used by the landing hero code panel.
          background: '#1b1a17',
          color: '#e8e6e0',
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          fontSize: 12.5,
          lineHeight: 1.7,
          padding: '18px 20px',
          borderRadius: 12,
          overflowX: 'auto',
          whiteSpace: 'pre',
          margin: 0,
        }}
      >
        {code}
      </pre>
      <div style={{ position: 'absolute', top: 12, right: 12 }}>
        <CopyButton text={code} />
      </div>
    </div>
  );
}

// ── Step chip ─────────────────────────────────────────────────────────────────

function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        marginBottom: 22,
      }}
    >
      <div style={v17.stepNum}>{n}</div>
      <div style={{ flex: 1 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--ink, #0f172a)',
            marginBottom: 6,
          }}
        >
          {title}
        </div>
        {children}
      </div>
    </div>
  );
}

// ── Connected panel ───────────────────────────────────────────────────────────

function ConnectedPanel({ appName }: { appName: string }) {
  return (
    <div
      style={{
        background: 'linear-gradient(180deg,var(--accent-bg,#ecfdf5),#fff)',
        border: '1px solid var(--accent-border,#a7f3d0)',
        borderRadius: 14,
        padding: '22px 24px',
        marginTop: 10,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          marginBottom: 14,
        }}
      >
        <div
          style={{
            width: 44,
            height: 44,
            borderRadius: 12,
            background: '#fff',
            border: '1px solid var(--accent-border,#a7f3d0)',
            color: 'var(--accent,#059669)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>
        <div style={{ flex: 1 }}>
          <div
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 10.5,
              fontWeight: 600,
              color: 'var(--accent,#059669)',
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              marginBottom: 2,
            }}
          >
            Connected
          </div>
          <div
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 20,
              fontWeight: 600,
              letterSpacing: '-0.015em',
              lineHeight: 1.2,
              color: 'var(--ink,#0f172a)',
            }}
          >
            Claude can now use {appName}.
          </div>
        </div>
      </div>
      <p
        style={{
          fontSize: 13,
          color: 'var(--text-2,#334155)',
          margin: '0 0 4px',
          lineHeight: 1.55,
        }}
      >
        Ask Claude to{' '}
        <strong style={{ color: 'var(--ink,#0f172a)' }}>
          "use {appName} to…"
        </strong>{' '}
        and watch for a tool-call chip. If no chip appears, restart the client
        once more.
      </p>
    </div>
  );
}

// ── Tab content per client ────────────────────────────────────────────────────

// Props shared by every tab so the active tab can render the Connected
// panel when the user has confirmed install, and a "Check install" button
// otherwise. Simulated detection for now — real probes land once each
// client ships a connection-status endpoint.
interface TabContentProps {
  slug: string | null;
  appName: string;
  connected: boolean;
  onMarkInstalled: () => void;
}

function InstallFooter({
  connected,
  onMarkInstalled,
  appName,
}: {
  connected: boolean;
  onMarkInstalled: () => void;
  appName: string;
}) {
  if (connected) return <ConnectedPanel appName={appName} />;
  return (
    <div
      style={{
        marginTop: 8,
        padding: '18px 20px',
        background: 'var(--surface-2,#f5f4f0)',
        border: '1px dashed var(--border-hover,#c4c1b8)',
        borderRadius: 12,
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        flexWrap: 'wrap',
      }}
    >
      <div style={{ flex: 1, minWidth: 220 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--ink,#0f172a)',
            marginBottom: 2,
          }}
        >
          Installed it?
        </div>
        <div
          style={{
            fontSize: 12,
            color: 'var(--muted,#64748b)',
            lineHeight: 1.5,
          }}
        >
          Confirm once you see the MCP server listed in your client. We'll show the
          next steps.
        </div>
      </div>
      <button
        type="button"
        onClick={onMarkInstalled}
        data-testid="install-mark-installed"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          padding: '9px 16px',
          background: '#fff',
          color: 'var(--ink,#0f172a)',
          border: '1px solid var(--border,#eceae4)',
          borderRadius: 9,
          fontSize: 13,
          fontWeight: 600,
          cursor: 'pointer',
          fontFamily: 'inherit',
        }}
      >
        I've installed it
      </button>
    </div>
  );
}

function DesktopTabContent({ slug, appName, connected, onMarkInstalled }: TabContentProps) {
  return (
    <>
      <Step
        n={1}
        title="Open the Claude Desktop config file"
      >
        <div style={{ fontSize: 12.5, color: 'var(--muted,#64748b)', lineHeight: 1.6 }}>
          Mac:{' '}
          <span style={v17.pathTag}>
            ~/Library/Application Support/Claude/claude_desktop_config.json
          </span>
        </div>
        <div
          style={{
            fontSize: 12.5,
            color: 'var(--muted,#64748b)',
            lineHeight: 1.6,
            marginTop: 4,
          }}
        >
          Windows:{' '}
          <span style={v17.pathTag}>%APPDATA%\Claude\claude_desktop_config.json</span>
        </div>
      </Step>

      <Step
        n={2}
        title={
          <>
            Paste this block. If the file already has an{' '}
            <code
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 11,
                background: 'var(--surface-2,#f5f4f0)',
                padding: '1px 4px',
                borderRadius: 3,
              }}
            >
              mcpServers
            </code>{' '}
            key, add just the{' '}
            <code
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 11,
                background: 'var(--surface-2,#f5f4f0)',
                padding: '1px 4px',
                borderRadius: 3,
              }}
            >
              "{slug ?? 'floom'}"
            </code>{' '}
            entry.
          </>
        }
      >
        <CodeBlock code={desktopSnippet(slug)} />
      </Step>

      <Step n={3} title="Quit and reopen Claude Desktop">
        <div style={{ fontSize: 12.5, color: 'var(--muted,#64748b)' }}>
          Claude only loads MCP servers on startup.
        </div>
      </Step>

      <Step
        n={4}
        title="Ask Claude to use it"
      >
        <CodeBlock
          code={`// try this prompt\nuse ${appName} to help me`}
        />
      </Step>

      <InstallFooter
        connected={connected}
        onMarkInstalled={onMarkInstalled}
        appName={appName}
      />
    </>
  );
}

function ClaudeCodeTabContent({ slug, appName, connected, onMarkInstalled }: TabContentProps) {
  return (
    <>
      <Step
        n={1}
        title="Run one command in your terminal"
      >
        <CodeBlock code={claudeCodeSnippet(slug)} />
        <div style={v17.callout}>
          This registers the MCP server for all future Claude Code sessions.
        </div>
      </Step>

      <Step n={2} title="Start a Claude Code session">
        <CodeBlock code="claude" />
      </Step>

      <Step
        n={3}
        title="Verify the server is active"
      >
        <CodeBlock code="claude mcp list" />
        <div style={v17.callout}>
          You should see{' '}
          <strong>{slug ?? 'floom'}</strong> listed as connected.
        </div>
      </Step>

      <Step
        n={4}
        title="Use it"
      >
        <CodeBlock
          code={`# in your claude session\nuse ${appName} to help me`}
        />
      </Step>

      <InstallFooter
        connected={connected}
        onMarkInstalled={onMarkInstalled}
        appName={appName}
      />
    </>
  );
}

function CursorTabContent({ slug, appName, connected, onMarkInstalled }: TabContentProps) {
  return (
    <>
      <Step
        n={1}
        title="Open Cursor Settings"
      >
        <div style={{ fontSize: 12.5, color: 'var(--muted,#64748b)' }}>
          Go to <strong>Cursor Settings</strong> (
          <span style={v17.pathTag}>Cmd ,</span> on Mac) and navigate to{' '}
          <strong>Features &gt; MCP Servers</strong>.
        </div>
      </Step>

      <Step
        n={2}
        title="Add this config to your Cursor MCP settings file"
      >
        <CodeBlock code={cursorSnippet(slug)} />
        <div style={v17.callout}>
          Cursor's MCP config file is at{' '}
          <span style={v17.pathTag}>~/.cursor/mcp.json</span> (or via the UI).
        </div>
      </Step>

      <Step n={3} title="Restart Cursor">
        <div style={{ fontSize: 12.5, color: 'var(--muted,#64748b)' }}>
          MCP servers load on startup. After restarting, the server appears as
          connected in Settings.
        </div>
      </Step>

      <Step
        n={4}
        title="Ask the agent to use it"
      >
        <CodeBlock
          code={`// in Cursor's Composer (Cmd+I)\nuse ${appName} to help me`}
        />
      </Step>

      <InstallFooter
        connected={connected}
        onMarkInstalled={onMarkInstalled}
        appName={appName}
      />
    </>
  );
}

function OtherTabContent({ slug, appName, connected, onMarkInstalled }: TabContentProps) {
  const url = slug ? `${MCP_BASE}/app/${slug}` : `${MCP_BASE}/search`;
  return (
    <>
      <Step
        n={1}
        title="Copy the MCP endpoint URL"
      >
        <CodeBlock code={url} />
        <div style={v17.callout}>
          Transport: Streamable HTTP (MCP spec 2025-03-26). No auth required for
          public apps.
        </div>
      </Step>

      <Step
        n={2}
        title="Add it to your client's MCP server list"
      >
        <div style={{ fontSize: 12.5, color: 'var(--muted,#64748b)', lineHeight: 1.6 }}>
          The exact UI varies per client. In most tools: open Settings, find
          &quot;MCP Servers&quot; or &quot;Tools&quot;, and paste the URL
          above.
        </div>
        <CodeBlock code={otherSnippet(slug)} />
      </Step>

      <Step n={3} title="Restart the client">
        <div style={{ fontSize: 12.5, color: 'var(--muted,#64748b)' }}>
          Most clients only load MCP servers on startup.
        </div>
      </Step>

      <Step
        n={4}
        title="Test it"
      >
        <CodeBlock
          code={`use ${appName} to help me`}
        />
      </Step>

      <InstallFooter
        connected={connected}
        onMarkInstalled={onMarkInstalled}
        appName={appName}
      />
    </>
  );
}

// ── Tab bar ───────────────────────────────────────────────────────────────────

const TABS: Array<{ id: ClientTab; label: string; sub: string; icon: React.ReactNode }> = [
  {
    id: 'desktop',
    label: 'Claude Desktop',
    sub: 'Mac + Windows app',
    icon: (
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
      </svg>
    ),
  },
  {
    id: 'code',
    label: 'Claude Code',
    sub: 'CLI · terminal',
    icon: (
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polyline points="4 17 10 11 4 5" />
        <line x1="12" y1="19" x2="20" y2="19" />
      </svg>
    ),
  },
  {
    id: 'cursor',
    label: 'Cursor',
    sub: 'IDE · MCP entry',
    icon: (
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 2l10 6v8l-10 6L2 16V8l10-6z" />
      </svg>
    ),
  },
  {
    id: 'other',
    label: 'Other MCP client',
    sub: 'Zed, VS Code, ChatGPT…',
    icon: (
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="10" />
        <path d="M12 8v4l3 2" />
      </svg>
    ),
  },
];

// ── Main component ────────────────────────────────────────────────────────────

export function InstallInClaudePage({ app }: InstallInClaudePageProps) {
  const [activeTab, setActiveTab] = useState<ClientTab>('desktop');
  // Waitlist mode (floom.dev): /me/apps is WaitlistGuard'd and redirects
  // to /waitlist, which would loop users back from this finish CTA. In
  // that mode, send them to /apps (public, always accessible) instead.
  const deployEnabled = useDeployEnabled();
  const finishHref = deployEnabled === false ? '/apps' : '/me/apps';
  const finishLabel =
    deployEnabled === false ? 'Browse all apps →' : 'Done, open My apps →';
  // Simulated connection detection. Each tab tracks its own state so
  // switching tabs doesn't incorrectly claim a different client is
  // connected. Real MCP probes land once each client exposes a
  // "list-servers" introspection endpoint we can call from the browser.
  const [connectedTabs, setConnectedTabs] = useState<Record<ClientTab, boolean>>({
    desktop: false,
    code: false,
    cursor: false,
    other: false,
  });
  const markInstalled = () =>
    setConnectedTabs((prev) => ({ ...prev, [activeTab]: true }));
  const navigate = useNavigate();

  const slug = app?.slug ?? null;
  const appName = app?.name ?? 'Floom apps';
  const pageTitle = app
    ? `Install ${app.name} in Claude · Floom`
    : 'Install in Claude · Floom';

  return (
    <PageShell title={pageTitle} contentStyle={{ padding: 0, maxWidth: '100%' }}>
      <main
        id="main"
        className="install-in-claude-main"
        data-testid="install-in-claude-page"
        style={{ maxWidth: 900, margin: '0 auto', padding: '40px 24px 80px' }}
      >
        {/* Breadcrumb / back link */}
        {app && (
          <nav
            aria-label="Breadcrumb"
            style={{
              fontSize: 13,
              color: 'var(--muted,#64748b)',
              marginBottom: 20,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <Link
              to={`/p/${app.slug}`}
              style={{ color: 'var(--muted,#64748b)', textDecoration: 'none' }}
            >
              {app.name}
            </Link>
            <span>›</span>
            <span style={{ color: 'var(--ink,#0f172a)' }}>Install in Claude</span>
          </nav>
        )}

        {/* Hero */}
        <div
          style={{
            textAlign: 'center',
            maxWidth: 700,
            margin: '0 auto 32px',
          }}
        >
          {app && (
            <div
              style={{
                width: 52,
                height: 52,
                borderRadius: 14,
                background: app.iconBg,
                color: app.iconFg,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: 700,
                fontSize: 18,
                margin: '0 auto 14px',
              }}
            >
              {app.initials}
            </div>
          )}

          <div style={v17.monoTag}>Install in Claude</div>

          <h1
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 36,
              fontWeight: 700,
              letterSpacing: '-0.02em',
              lineHeight: 1.1,
              color: 'var(--ink,#0f172a)',
              margin: '0 0 12px',
            }}
          >
            {app ? `Run ${app.name} from Claude.` : 'Use Floom apps from Claude.'}
          </h1>

          <p
            style={{
              color: 'var(--muted,#64748b)',
              fontSize: 15,
              maxWidth: 480,
              margin: '0 auto',
              lineHeight: 1.6,
            }}
          >
            Pick your client. Copy the config block. Restart the app. Done — about
            30 seconds.
          </p>
        </div>

        {/* Client tabs */}
        <div
          role="tablist"
          aria-label="MCP client"
          className="install-mcp-tablist"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: 10,
            marginBottom: 24,
          }}
        >
          {TABS.map((tab) => {
            const isOn = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={isOn}
                onClick={() => setActiveTab(tab.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '16px 18px',
                  border: isOn
                    ? '1px solid var(--ink,#0f172a)'
                    : '1px solid var(--border,#eceae4)',
                  borderRadius: 13,
                  background: isOn ? 'var(--surface-2,#f5f4f0)' : '#fff',
                  boxShadow: isOn ? '0 0 0 3px rgba(15,23,42,.05)' : 'none',
                  cursor: 'pointer',
                  textAlign: 'left',
                  color: 'inherit',
                  transition: 'all .15s',
                }}
              >
                <div
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 9,
                    background: isOn ? '#fff' : 'var(--surface-2,#f5f4f0)',
                    border: isOn ? '1px solid var(--ink,#0f172a)' : 'none',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                    color: isOn ? 'var(--ink,#0f172a)' : 'var(--muted,#64748b)',
                  }}
                >
                  {tab.icon}
                </div>
                <div>
                  <div
                    style={{
                      fontSize: 13.5,
                      fontWeight: 600,
                      color: 'var(--ink,#0f172a)',
                      lineHeight: 1.2,
                    }}
                  >
                    {tab.label}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: 'var(--muted,#64748b)',
                      marginTop: 2,
                    }}
                  >
                    {tab.sub}
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        {/* Steps + code for active tab */}
        <div
          style={{
            background: '#fff',
            border: '1px solid var(--border,#eceae4)',
            borderRadius: 16,
            padding: '28px 32px',
          }}
        >
          {activeTab === 'desktop' && (
            <DesktopTabContent
              slug={slug}
              appName={appName}
              connected={connectedTabs.desktop}
              onMarkInstalled={markInstalled}
            />
          )}
          {activeTab === 'code' && (
            <ClaudeCodeTabContent
              slug={slug}
              appName={appName}
              connected={connectedTabs.code}
              onMarkInstalled={markInstalled}
            />
          )}
          {activeTab === 'cursor' && (
            <CursorTabContent
              slug={slug}
              appName={appName}
              connected={connectedTabs.cursor}
              onMarkInstalled={markInstalled}
            />
          )}
          {activeTab === 'other' && (
            <OtherTabContent
              slug={slug}
              appName={appName}
              connected={connectedTabs.other}
              onMarkInstalled={markInstalled}
            />
          )}
        </div>

        {/* Footer actions */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            marginTop: 28,
            paddingTop: 24,
            borderTop: '1px solid var(--border,#eceae4)',
            flexWrap: 'wrap',
          }}
        >
          {app ? (
            <button
              type="button"
              onClick={() => navigate(`/p/${app.slug}`)}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--muted,#64748b)',
                fontSize: 13.5,
                fontWeight: 500,
                cursor: 'pointer',
                fontFamily: 'inherit',
                padding: '10px 0',
              }}
            >
              ← Back to {app.name}
            </button>
          ) : (
            <Link
              to="/apps"
              style={{
                color: 'var(--muted,#64748b)',
                fontSize: 13.5,
                fontWeight: 500,
                textDecoration: 'none',
              }}
            >
              ← Browse apps
            </Link>
          )}

          <Link
            to={finishHref}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 18px',
              background: 'var(--accent,#059669)',
              color: '#fff',
              borderRadius: 10,
              fontSize: 13.5,
              fontWeight: 600,
              textDecoration: 'none',
              border: '1px solid var(--accent,#059669)',
            }}
          >
            {finishLabel}
          </Link>
        </div>

      </main>
    </PageShell>
  );
}
