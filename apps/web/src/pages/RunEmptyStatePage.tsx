import { Link } from 'react-router-dom';
import { WorkspaceHeader, WorkspacePageShell } from '../components/WorkspacePageShell';

export function RunEmptyStatePage() {
  return (
    <WorkspacePageShell mode="run" title="Workspace Run | Floom">
      <WorkspaceHeader
        eyebrow="Workspace"
        title="Workspace Run"
        scope="Install or run the first app to start building workspace run history."
        actions={<Link to="/apps" style={primaryLinkStyle}>Browse apps</Link>}
      />
      <section style={cardStyle}>
        <h2 style={h2Style}>No workspace runs yet</h2>
        <p style={mutedStyle}>Run a public app, install it in Claude, or publish from Studio.</p>
      </section>
    </WorkspacePageShell>
  );
}

const cardStyle: React.CSSProperties = {
  border: '1px dashed var(--line)',
  borderRadius: 12,
  background: 'var(--card)',
  padding: 24,
};

const h2Style: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 800,
  color: 'var(--ink)',
  margin: '0 0 8px',
};

const mutedStyle: React.CSSProperties = {
  fontSize: 14,
  color: 'var(--muted)',
  margin: 0,
};

const primaryLinkStyle: React.CSSProperties = {
  border: '1px solid var(--ink)',
  borderRadius: 8,
  padding: '10px 14px',
  background: 'var(--ink)',
  color: '#fff',
  fontSize: 13,
  fontWeight: 700,
  textDecoration: 'none',
};
