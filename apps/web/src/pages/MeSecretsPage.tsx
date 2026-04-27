import { useEffect, useState } from 'react';
import { WorkspaceHeader, WorkspacePageShell } from '../components/WorkspacePageShell';
import { useSession } from '../hooks/useSession';
import * as api from '../api/client';
import type { UserSecretEntry } from '../lib/types';

export function SettingsByokKeysPage() {
  const { data: session } = useSession();
  const workspace = session?.active_workspace;
  const [entries, setEntries] = useState<UserSecretEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keyName, setKeyName] = useState('');
  const [keyValue, setKeyValue] = useState('');
  const [saving, setSaving] = useState(false);

  async function load() {
    if (!workspace) return;
    try {
      const res = await api.listWorkspaceSecrets(workspace.id);
      setEntries(res.entries);
      setError(null);
    } catch (err) {
      setEntries([]);
      setError((err as Error).message || 'Failed to load BYOK keys');
    }
  }

  useEffect(() => {
    void load();
  }, [workspace?.id]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!workspace || !keyName.trim() || !keyValue.trim()) return;
    setSaving(true);
    try {
      await api.setWorkspaceSecret(workspace.id, keyName.trim(), keyValue);
      setKeyName('');
      setKeyValue('');
      await load();
    } catch (err) {
      setError((err as Error).message || 'Failed to replace BYOK key');
    } finally {
      setSaving(false);
    }
  }

  async function remove(key: string) {
    if (!workspace) return;
    setSaving(true);
    try {
      await api.deleteWorkspaceSecret(workspace.id, key);
      await load();
    } catch (err) {
      setError((err as Error).message || 'Failed to delete BYOK key');
    } finally {
      setSaving(false);
    }
  }

  return (
    <WorkspacePageShell mode="settings" title="BYOK keys | Floom">
      <WorkspaceHeader
        eyebrow="Workspace settings"
        title="BYOK keys"
        scope={`Applies to ${workspace?.name || 'this workspace'}.`}
      />

      <section style={cardStyle}>
        <div style={sectionHeadStyle}>
          <div>
            <h2 style={h2Style}>Workspace BYOK keys</h2>
            <p style={mutedStyle}>
              Runtime credentials for installed apps. Values are encrypted and never shown again after save.
            </p>
          </div>
        </div>

        {error ? <div role="alert" style={errorStyle}>{error}</div> : null}

        <form onSubmit={save} style={formStyle}>
          <input
            value={keyName}
            onChange={(e) => setKeyName(e.target.value.toUpperCase())}
            placeholder="GEMINI_API_KEY"
            aria-label="BYOK key name"
            style={inputStyle}
          />
          <input
            value={keyValue}
            onChange={(e) => setKeyValue(e.target.value)}
            placeholder="Paste value"
            aria-label="BYOK key value"
            type="password"
            style={inputStyle}
          />
          <button type="submit" disabled={saving || !keyName.trim() || !keyValue.trim()} style={primaryButtonStyle}>
            {saving ? 'Replacing...' : 'Replace'}
          </button>
        </form>

        {entries === null ? (
          <div style={placeholderStyle}>Loading BYOK keys...</div>
        ) : entries.length === 0 ? (
          <div data-testid="settings-byok-empty" style={emptyStyle}>
            <strong>No BYOK keys yet</strong>
            <p style={mutedStyle}>Add the first workspace credential above. Apps that require it can run from browser, CLI, HTTP, and MCP after it is saved.</p>
          </div>
        ) : (
          <div data-testid="settings-byok-list" style={listStyle}>
            {entries.map((entry) => (
              <div key={entry.key} style={rowStyle}>
                <div>
                  <div style={monoStrongStyle}>{entry.key}</div>
                  <div style={mutedSmallStyle}>Updated {entry.updated_at ? new Date(entry.updated_at).toLocaleString() : 'recently'}</div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" onClick={() => setKeyName(entry.key)} style={secondaryButtonStyle}>
                    Replace
                  </button>
                  <button type="button" onClick={() => void remove(entry.key)} disabled={saving} style={dangerButtonStyle}>
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </WorkspacePageShell>
  );
}

export function MeSecretsPage() {
  return <SettingsByokKeysPage />;
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
  margin: '0 0 4px',
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
  gridTemplateColumns: 'minmax(180px, 0.8fr) minmax(220px, 1fr) auto',
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
