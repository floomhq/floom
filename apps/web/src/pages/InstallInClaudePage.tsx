import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageShell } from '../components/PageShell';
import { useSession } from '../hooks/useSession';
import * as api from '../api/client';
import type { CreatedAgentToken } from '../api/client';
import type { SessionWorkspace } from '../lib/types';

async function copyToClipboard(text: string): Promise<void> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
  } catch (e) { console.error(e); }
}

interface AppMeta {
  slug: string;
  name: string;
  initials: string;
  iconBg: string;
  iconFg: string;
}

interface InstallInClaudePageProps {
  app?: AppMeta;
}

type TokenState = {
  creating: boolean;
  created: CreatedAgentToken | null;
  error: string | null;
};

export function InstallInClaudePage({ app }: InstallInClaudePageProps) {
  const { data: session } = useSession();
  const [tokenState, setTokenState] = useState<Record<string, TokenState>>({});
  const [heroCopied, setHeroCopied] = useState(false);
  const workspaces = useMemo<SessionWorkspace[]>(() => {
    if (session?.workspaces?.length) return session.workspaces;
    if (session?.active_workspace) return [session.active_workspace];
    return [{ id: 'local', slug: 'local', name: 'Local', role: 'admin' }];
  }, [session?.active_workspace, session?.workspaces]);
  const title = app ? `Install ${app.name} in your AI tool` : 'Install Floom in your AI tool';
  const exampleSlug = app?.slug || 'competitor-lens';

  async function handleHeroCopy() {
    const text = `claude skill add floom.dev/${exampleSlug}`;
    await copyToClipboard(text);
    setHeroCopied(true);
    window.setTimeout(() => setHeroCopied(false), 1500);
  }

  async function createAgentToken(workspace: SessionWorkspace) {
    setTokenState((prev) => ({
      ...prev,
      [workspace.id]: { creating: true, created: prev[workspace.id]?.created ?? null, error: null },
    }));
    try {
      const created = await api.createWorkspaceAgentToken(workspace.id, {
        label: `claude-${workspace.slug || slugifyWorkspaceName(workspace.name)}`,
        scope: 'read-write',
      });
      setTokenState((prev) => ({
        ...prev,
        [workspace.id]: { creating: false, created, error: null },
      }));
    } catch (err) {
      setTokenState((prev) => ({
        ...prev,
        [workspace.id]: {
          creating: false,
          created: prev[workspace.id]?.created ?? null,
          error: (err as Error).message || 'Could not create Agent token',
        },
      }));
    }
  }

  return (
    <PageShell
      title={`${title} | Floom`}
      description="Install Floom apps in your AI tool, publish apps to Floom, and mint workspace Agent tokens for MCP clients."
      contentStyle={{ maxWidth: 1120 }}
    >
      <main data-testid="install-in-claude-page" style={pageStyle}>
        <section style={heroStyle}>
          <div style={kickerStyle}>Works with Claude Desktop, Cursor, Codex, and any MCP client</div>
          <h1 style={h1Style}>{title}</h1>
          <p style={subStyle}>
            One command for public apps. Workspace cards for private apps and publisher access.
          </p>
          {app ? (
            <div style={appPillStyle}>
              <span style={{ ...appIconStyle, background: app.iconBg, color: app.iconFg }}>{app.initials}</span>
              <span>{app.name}</span>
            </div>
          ) : null}
          <div style={heroCommandStyle}>
            <span><span style={codeMuteStyle}>$</span> claude skill add floom.dev/{exampleSlug}</span>
            <button
              type="button"
              data-testid="install-copy-btn"
              style={heroCopied ? { ...copyButtonStyle, background: 'rgba(255,255,255,0.12)', color: '#d4d4c8', border: '1px solid rgba(212,212,200,0.2)' } : copyButtonStyle}
              onClick={() => void handleHeroCopy()}
            >
              {heroCopied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </section>

        <section aria-label="Install choices" style={choiceGridStyle}>
          <a href="#use" style={choiceCardStyle}>
            <div style={choiceNumStyle}>1</div>
            <div>
              <h2 style={h2Style}>Use Floom apps in your AI tool</h2>
              <p style={mutedStyle}>Install a public app as a Skill, or connect a workspace through MCP with an Agent token.</p>
            </div>
          </a>
          <a href="#publish" style={choiceCardStyle}>
            <div style={choiceNumStyle}>2</div>
            <div>
              <h2 style={h2Style}>Publish your app to Floom</h2>
              <p style={mutedStyle}>Turn a repo, OpenAPI URL, or floom.yaml into a hosted app any agent can call by name.</p>
            </div>
          </a>
        </section>

        <section id="use" style={sectionStyle}>
          <h2 style={sectionTitleStyle}>Install a public app</h2>
          <div style={stepStackStyle}>
            <Step number="1" title="Open your AI tool">
              Claude Desktop, Cursor, Codex, and other MCP clients can use Floom.
            </Step>
            <Step number="2" title="Run the Skill add command">
              <pre style={codeStyle}>claude skill add floom.dev/{exampleSlug}</pre>
            </Step>
            <Step number="3" title="Use it by name">
              <pre style={codeStyle}>{`"Compare stripe.com vs adyen.com with ${exampleSlug}."`}</pre>
            </Step>
          </div>
        </section>

        <section id="publish" style={sectionStyle}>
          <h2 style={sectionTitleStyle}>Publish from your agent</h2>
          <pre style={codeStyle}>{`curl -fsSL https://floom.dev/install.sh | bash
floom init --name "My App" --openapi-url https://example.com/openapi.yaml
FLOOM_API_KEY=floom_agent_•••••• floom deploy ./floom.yaml`}</pre>
          <Link to="/studio/build" style={primaryLinkStyle}>Open Studio</Link>
        </section>

        <section style={sectionStyle}>
          <div style={sectionHeaderStyle}>
            <div>
              <h2 style={sectionTitleStyle}>Workspace MCP helper</h2>
              <p style={{ ...mutedStyle, marginTop: 6 }}>
                One card appears for each workspace the current user can access. v1 users see a single card.
              </p>
            </div>
          </div>
          <div style={workspaceGridStyle}>
            {workspaces.map((workspace) => (
              <WorkspaceCard
                key={workspace.id}
                workspace={workspace}
                tokenState={tokenState[workspace.id] ?? { creating: false, created: null, error: null }}
                onCreate={() => void createAgentToken(workspace)}
              />
            ))}
          </div>
        </section>
      </main>
    </PageShell>
  );
}

function Step({ number, title, children }: { number: string; title: string; children: React.ReactNode }) {
  return (
    <article style={stepCardStyle}>
      <div style={numStyle}>{number}</div>
      <div>
        <h3 style={h3Style}>{title}</h3>
        <div style={mutedStyle}>{children}</div>
      </div>
    </article>
  );
}

function WorkspaceCard({
  workspace,
  tokenState,
  onCreate,
}: {
  workspace: SessionWorkspace;
  tokenState: TokenState;
  onCreate: () => void;
}) {
  const entryName = `floom-${slugifyWorkspaceName(workspace.name || workspace.slug || workspace.id)}`;
  const token = tokenState.created?.raw_token || 'floom_agent_••••••';
  const route = `/api/workspaces/${workspace.id}/agent-tokens`;
  const snippet = `claude mcp add ${entryName} --env FLOOM_API_KEY=${token} -- floom mcp`;

  return (
    <article style={workspaceCardStyle} data-testid={`install-workspace-card-${workspace.id}`}>
      <div style={workspaceTopStyle}>
        <div>
          <h3 style={h3Style}>{workspace.name}</h3>
          <p style={mutedStyle}>MCP entry name: <code style={monoInlineStyle}>{entryName}</code></p>
        </div>
        <span style={rolePillStyle}>{workspace.role}</span>
      </div>
      <p style={{ ...mutedStyle, marginTop: 10 }}>
        Agent token: <code style={monoInlineStyle}>{tokenState.created ? maskToken(token) : 'floom_agent_••••••'}</code>
      </p>
      {tokenState.created ? (
        <pre style={tokenBlockStyle}>{token}</pre>
      ) : null}
      <pre style={miniCodeStyle}>{snippet}</pre>
      {tokenState.error ? <div role="alert" style={errorStyle}>{tokenState.error}</div> : null}
      <button
        type="button"
        onClick={onCreate}
        disabled={tokenState.creating}
        data-route={route}
        style={secondaryButtonStyle}
      >
        {tokenState.creating ? 'Creating...' : 'Create Agent token'}
      </button>
    </article>
  );
}

function slugifyWorkspaceName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'workspace';
}

function maskToken(token: string): string {
  if (token.startsWith('floom_agent_')) return 'floom_agent_••••••';
  return 'floom_agent_••••••';
}

const pageStyle: React.CSSProperties = {
  display: 'grid',
  gap: 28,
};

const heroStyle: React.CSSProperties = {
  padding: '52px 0 8px',
  maxWidth: 820,
  margin: '0 auto',
  textAlign: 'center',
};

const kickerStyle: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 11,
  fontWeight: 800,
  color: 'var(--accent)',
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  marginBottom: 14,
};

const h1Style: React.CSSProperties = {
  fontFamily: 'var(--font-display)',
  fontSize: 48,
  fontWeight: 850,
  letterSpacing: 0,
  lineHeight: 1.05,
  color: 'var(--ink)',
  margin: 0,
};

const subStyle: React.CSSProperties = {
  fontSize: 16,
  lineHeight: 1.55,
  color: 'var(--muted)',
  maxWidth: 600,
  margin: '14px auto 0',
};

const heroCommandStyle: React.CSSProperties = {
  maxWidth: 560,
  margin: '24px auto 0',
  background: '#1b1a17',
  color: '#e7e3d7',
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 13,
  padding: '14px 18px',
  borderRadius: 10,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  textAlign: 'left',
};

const codeMuteStyle: React.CSSProperties = { color: '#9ca3af' };

const copyButtonStyle: React.CSSProperties = {
  background: 'var(--accent)',
  color: '#fff',
  border: 0,
  borderRadius: 6,
  padding: '6px 12px',
  fontSize: 11,
  fontWeight: 800,
  fontFamily: 'inherit',
  cursor: 'pointer',
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
};

const choiceGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
  gap: 14,
};

const choiceCardStyle: React.CSSProperties = {
  border: '1px solid var(--line)',
  borderRadius: 8,
  background: 'var(--card)',
  padding: 22,
  display: 'grid',
  gridTemplateColumns: '42px 1fr',
  gap: 16,
  textDecoration: 'none',
  color: 'var(--ink)',
};

const choiceNumStyle: React.CSSProperties = {
  width: 36,
  height: 36,
  borderRadius: 10,
  background: 'var(--accent)',
  color: '#fff',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 14,
  fontWeight: 800,
};

const sectionStyle: React.CSSProperties = {
  borderTop: '1px solid var(--line)',
  paddingTop: 24,
};

const sectionHeaderStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  gap: 14,
  marginBottom: 14,
};

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 22,
  fontWeight: 850,
  color: 'var(--ink)',
  margin: 0,
};

const h2Style: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 850,
  color: 'var(--ink)',
  margin: '0 0 8px',
};

const h3Style: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 850,
  color: 'var(--ink)',
  margin: '0 0 6px',
};

const mutedStyle: React.CSSProperties = {
  fontSize: 13,
  color: 'var(--muted)',
  lineHeight: 1.55,
  margin: 0,
};

const stepStackStyle: React.CSSProperties = {
  display: 'grid',
  gap: 14,
  maxWidth: 760,
};

const stepCardStyle: React.CSSProperties = {
  border: '1px solid var(--line)',
  borderRadius: 8,
  background: 'var(--card)',
  padding: '22px 24px',
  display: 'grid',
  gridTemplateColumns: '44px 1fr',
  gap: 16,
  alignItems: 'flex-start',
};

const numStyle: React.CSSProperties = {
  width: 36,
  height: 36,
  borderRadius: 10,
  background: 'var(--accent)',
  color: '#fff',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontFamily: 'JetBrains Mono, monospace',
  fontWeight: 800,
  fontSize: 14,
};

const codeStyle: React.CSSProperties = {
  background: '#1b1a17',
  color: '#e7e3d7',
  borderRadius: 8,
  padding: 14,
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 12.5,
  lineHeight: 1.6,
  overflowX: 'auto',
  margin: '10px 0 0',
};

const miniCodeStyle: React.CSSProperties = {
  ...codeStyle,
  fontSize: 11.5,
  margin: '14px 0 0',
  whiteSpace: 'pre-wrap',
};

const tokenBlockStyle: React.CSSProperties = {
  ...codeStyle,
  margin: '10px 0 0',
  background: '#fff8ed',
  color: 'var(--ink)',
  border: '1px solid #f1d5aa',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
};

const primaryLinkStyle: React.CSSProperties = {
  display: 'inline-flex',
  border: '1px solid var(--ink)',
  borderRadius: 8,
  padding: '10px 14px',
  background: 'var(--ink)',
  color: '#fff',
  textDecoration: 'none',
  fontSize: 13,
  fontWeight: 800,
  marginTop: 12,
};

const secondaryButtonStyle: React.CSSProperties = {
  display: 'inline-flex',
  border: '1px solid var(--line)',
  borderRadius: 8,
  padding: '9px 12px',
  background: 'var(--bg)',
  color: 'var(--ink)',
  fontSize: 12,
  fontWeight: 800,
  marginTop: 12,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const workspaceGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
  gap: 14,
};

const workspaceCardStyle: React.CSSProperties = {
  border: '1px solid var(--line)',
  borderRadius: 8,
  background: 'var(--card)',
  padding: 18,
};

const workspaceTopStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 12,
  alignItems: 'flex-start',
};

const rolePillStyle: React.CSSProperties = {
  border: '1px solid var(--line)',
  borderRadius: 999,
  padding: '3px 8px',
  fontSize: 11,
  color: 'var(--muted)',
  fontFamily: 'JetBrains Mono, monospace',
};

const appPillStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  marginTop: 16,
  border: '1px solid var(--line)',
  borderRadius: 999,
  padding: '6px 10px',
  fontSize: 13,
  fontWeight: 700,
};

const appIconStyle: React.CSSProperties = {
  width: 26,
  height: 26,
  borderRadius: 8,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 11,
  fontWeight: 800,
};

const monoInlineStyle: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 12,
  color: 'var(--ink)',
};

const errorStyle: React.CSSProperties = {
  marginTop: 10,
  border: '1px solid #f4b7b1',
  background: '#fdecea',
  color: '#9f2415',
  borderRadius: 8,
  padding: '8px 10px',
  fontSize: 12,
};
