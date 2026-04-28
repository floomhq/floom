import { useEffect, useState } from 'react';
import { WorkspaceHeader, WorkspacePageShell } from '../components/WorkspacePageShell';
import { useSession } from '../hooks/useSession';
import * as api from '../api/client';
import type { AgentTokenRecord, AgentTokenScope, CreatedAgentToken } from '../api/client';

export function SettingsAgentTokensPage() {
  const { data: session } = useSession();
  const workspace = session?.active_workspace;
  const [tokens, setTokens] = useState<AgentTokenRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [scope, setScope] = useState<AgentTokenScope>('read-write');
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedAgentToken | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<AgentTokenRecord | null>(null);

  async function load() {
    if (!workspace) return;
    try {
      setTokens(await api.listWorkspaceAgentTokens(workspace.id));
      setError(null);
    } catch (err) {
      setTokens([]);
      setError((err as Error).message || 'Failed to load Agent tokens');
    }
  }

  useEffect(() => {
    void load();
  }, [workspace?.id]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!workspace || !label.trim()) return;
    setCreating(true);
    try {
      const next = await api.createWorkspaceAgentToken(workspace.id, {
        label: label.trim(),
        scope,
      });
      setCreated(next);
      setLabel('');
      await load();
    } catch (err) {
      setError((err as Error).message || 'Failed to create Agent token');
    } finally {
      setCreating(false);
    }
  }

  async function revoke(token: AgentTokenRecord) {
    if (!workspace) return;
    try {
      await api.revokeWorkspaceAgentToken(workspace.id, token.id);
      setConfirmRevoke(null);
      await load();
    } catch (err) {
      setError((err as Error).message || 'Failed to revoke Agent token');
    }
  }

  return (
    <WorkspacePageShell mode="settings" title="Agent tokens | Floom">
      <WorkspaceHeader
        eyebrow="Workspace settings"
        title="Agent tokens"
        scope={`Applies to ${workspace?.name || 'this workspace'}.`}
      />

      {created ? <DisplayOnce created={created} onDismiss={() => setCreated(null)} /> : null}

      <section style={cardStyle}>
        <div style={sectionHeadStyle}>
          <div>
            <h2 style={h2Style}>Active Agent tokens</h2>
            <p style={mutedStyle}>
              Workspace credentials for MCP clients (Claude Desktop, Cursor, Codex), CLI, CI, and HTTP.
            </p>
          </div>
        </div>

        {error ? <div role="alert" style={errorStyle}>{error}</div> : null}

        <form onSubmit={create} style={formStyle}>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="claude-desktop"
            aria-label="Agent token label"
            style={inputStyle}
          />
          <select value={scope} onChange={(e) => setScope(e.target.value as AgentTokenScope)} style={inputStyle}>
            <option value="read-write">Read + run</option>
            <option value="read">Read only</option>
            <option value="publish-only">Publish only</option>
          </select>
          <button type="submit" disabled={creating || !label.trim()} style={primaryButtonStyle}>
            {creating ? 'Creating...' : 'Create Agent token'}
          </button>
        </form>

        {tokens === null ? (
          <div style={placeholderStyle}>Loading Agent tokens...</div>
        ) : tokens.filter((token) => !token.revoked).length === 0 ? (
          <div data-testid="settings-agent-tokens-empty" style={emptyStyle}>
            <strong>No Agent tokens yet</strong>
            <p style={mutedStyle}>Create the first workspace credential to use Floom from headless tools.</p>
          </div>
        ) : (
          <div data-testid="settings-agent-tokens-list" style={listStyle}>
            {tokens.filter((token) => !token.revoked).map((token) => (
              <div key={token.id} style={rowStyle}>
                <div>
                  <div style={monoStrongStyle}>{token.label}</div>
                  <div style={mutedSmallStyle}>
                    <span>{token.prefix ? `${token.prefix}••••••` : 'floom_agent_••••••'}</span> · {token.scope} · Issued by {token.issued_by_user_id || 'workspace member'}
                  </div>
                  <div style={mutedSmallStyle}>
                    Created {new Date(token.created_at).toLocaleString()}
                    {token.last_used_at ? ` · Last used ${new Date(token.last_used_at).toLocaleString()}` : ''}
                  </div>
                </div>
                <button type="button" onClick={() => setConfirmRevoke(token)} style={dangerButtonStyle}>
                  Revoke
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {confirmRevoke ? (
        <div role="dialog" aria-modal="true" aria-labelledby="revoke-title" style={modalBackdropStyle}>
          <div style={modalStyle}>
            <h2 id="revoke-title" style={h2Style}>Revoke Agent token?</h2>
            <p style={{ ...mutedStyle, marginTop: 8 }}>
              This immediately removes access for {confirmRevoke.label} in {workspace?.name || 'this workspace'}.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 18 }}>
              <button type="button" onClick={() => setConfirmRevoke(null)} style={secondaryButtonStyle}>Cancel</button>
              <button type="button" onClick={() => void revoke(confirmRevoke)} style={dangerSolidButtonStyle}>Revoke</button>
            </div>
          </div>
        </div>
      ) : null}
    </WorkspacePageShell>
  );
}

export function MeSettingsTokensPage() {
  return <SettingsAgentTokensPage />;
}

function DisplayOnce({ created, onDismiss }: { created: CreatedAgentToken; onDismiss: () => void }) {
  return (
    <section style={{ ...cardStyle, marginBottom: 18, background: '#fff8ed' }}>
      <h2 style={h2Style}>Copy this Agent token now</h2>
      <p style={{ ...mutedStyle, margin: '4px 0 12px' }}>Floom only shows the token once.</p>
      <pre style={tokenBlockStyle}>{created.raw_token || 'floom_agent_••••••'}</pre>
      <button type="button" onClick={onDismiss} style={secondaryButtonStyle}>Done</button>
    </section>
  );
}

const cardStyle: React.CSSProperties = {
  border: '1px solid var(--line)',
  borderRadius: 12,
  background: 'var(--card)',
  padding: 22,
};

const sectionHeadStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 14,
  marginBottom: 18,
};

const h2Style: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 750,
  margin: 0,
  color: 'var(--ink)',
};

const mutedStyle: React.CSSProperties = {
  fontSize: 13,
  lineHeight: 1.55,
  color: 'var(--muted)',
  margin: 0,
};

const mutedSmallStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--muted)',
  marginTop: 4,
};

const formStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(180px, 1fr) 160px auto',
  gap: 10,
  marginBottom: 18,
};

const inputStyle: React.CSSProperties = {
  border: '1px solid var(--line)',
  borderRadius: 8,
  padding: '10px 12px',
  fontSize: 13,
  color: 'var(--ink)',
  background: 'var(--bg)',
  fontFamily: 'inherit',
};

const primaryButtonStyle: React.CSSProperties = {
  border: '1px solid var(--ink)',
  borderRadius: 8,
  padding: '10px 14px',
  background: 'var(--ink)',
  color: '#fff',
  fontSize: 13,
  fontWeight: 700,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const secondaryButtonStyle: React.CSSProperties = {
  border: '1px solid var(--line)',
  borderRadius: 8,
  padding: '8px 11px',
  background: 'var(--bg)',
  color: 'var(--ink)',
  fontSize: 12,
  fontWeight: 700,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const dangerButtonStyle: React.CSSProperties = {
  ...secondaryButtonStyle,
  color: '#b91c1c',
};

const dangerSolidButtonStyle: React.CSSProperties = {
  ...primaryButtonStyle,
  borderColor: '#b91c1c',
  background: '#b91c1c',
};

const placeholderStyle: React.CSSProperties = {
  color: 'var(--muted)',
  fontSize: 13,
  padding: 16,
};

const emptyStyle: React.CSSProperties = {
  border: '1px dashed var(--line)',
  borderRadius: 10,
  padding: 18,
  background: 'var(--bg)',
};

const listStyle: React.CSSProperties = {
  border: '1px solid var(--line)',
  borderRadius: 10,
  overflow: 'hidden',
};

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  padding: '14px 16px',
  borderBottom: '1px solid var(--line)',
};

const monoStrongStyle: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 13,
  fontWeight: 700,
  color: 'var(--ink)',
};

const errorStyle: React.CSSProperties = {
  background: '#fdecea',
  border: '1px solid #f4b7b1',
  color: '#c2321f',
  borderRadius: 8,
  padding: '10px 12px',
  fontSize: 13,
  marginBottom: 14,
};

const tokenBlockStyle: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 12,
  background: '#1b1a17',
  color: '#d4d4c8',
  borderRadius: 8,
  padding: 14,
  overflowX: 'auto',
};

const modalBackdropStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(17, 24, 39, 0.28)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 80,
};

const modalStyle: React.CSSProperties = {
  width: 'min(420px, calc(100vw - 32px))',
  border: '1px solid var(--line)',
  borderRadius: 12,
  background: 'var(--card)',
  padding: 20,
  boxShadow: '0 18px 48px rgba(17,24,39,0.18)',
};
