import { Link } from 'react-router-dom';
import { WorkspaceHeader, WorkspacePageShell } from '../components/WorkspacePageShell';
import { useSession } from '../hooks/useSession';

export function SettingsStudioPage() {
  const { data: session } = useSession();
  const workspaceName = session?.active_workspace?.name || 'this workspace';

  return (
    <WorkspacePageShell mode="settings" title="Studio settings | Floom">
      <WorkspaceHeader
        eyebrow="Workspace settings"
        title="Studio settings"
        scope={`Studio-local configuration for ${workspaceName}.`}
      />

      <section style={gridStyle}>
        <div style={cardStyle}>
          <h2 style={h2Style}>General</h2>
          <p style={mutedStyle}>Creator defaults for publishing, app metadata, and Studio notifications.</p>
          <div style={stubStyle}>No editable Studio defaults are enabled for launch.</div>
        </div>
        <div style={cardStyle}>
          <h2 style={h2Style}>GitHub</h2>
          <p style={mutedStyle}>Connect a repository source for build and publish flows.</p>
          <div style={stubStyle}>GitHub connection management remains in the build flow for launch.</div>
        </div>
      </section>

      <section style={{ ...gridStyle, marginTop: 18 }}>
        <Link to="/settings/byok-keys" style={linkCardStyle}>
          <h2 style={h2Style}>BYOK keys</h2>
          <p style={mutedStyle}>Runtime credentials for apps installed in this workspace.</p>
        </Link>
        <Link to="/settings/agent-tokens" style={linkCardStyle}>
          <h2 style={h2Style}>Agent tokens</h2>
          <p style={mutedStyle}>Workspace credentials for Claude, CLI, MCP, HTTP, and CI.</p>
        </Link>
      </section>
    </WorkspacePageShell>
  );
}

export function StudioSettingsPage() {
  return <SettingsStudioPage />;
}

const gridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
  gap: 14,
};

const cardStyle: React.CSSProperties = {
  border: '1px solid var(--line)',
  borderRadius: 12,
  background: 'var(--card)',
  padding: 20,
};

const linkCardStyle: React.CSSProperties = {
  ...cardStyle,
  textDecoration: 'none',
  color: 'var(--ink)',
};

const h2Style: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 750,
  margin: '0 0 8px',
  color: 'var(--ink)',
};

const mutedStyle: React.CSSProperties = {
  fontSize: 13,
  lineHeight: 1.55,
  color: 'var(--muted)',
  margin: 0,
};

const stubStyle: React.CSSProperties = {
  marginTop: 16,
  border: '1px dashed var(--line)',
  borderRadius: 10,
  padding: 14,
  fontSize: 13,
  color: 'var(--muted)',
};
