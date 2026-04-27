import { Link } from 'react-router-dom';
import { WorkspacePageShell } from '../components/WorkspacePageShell';

export function StudioEmptyPage() {
  return (
    <WorkspacePageShell mode="studio" title="Studio | Floom">
      <section style={cardStyle}>
        <div style={kickerStyle}>Studio</div>
        <h1 style={h1Style}>No apps in this workspace yet</h1>
        <p style={bodyStyle}>Create the first app from a repo, OpenAPI spec, or local Floom manifest.</p>
        <Link to="/studio/build" style={primaryLinkStyle}>New app</Link>
      </section>
    </WorkspacePageShell>
  );
}

const cardStyle: React.CSSProperties = {
  border: '1px dashed var(--line)',
  borderRadius: 12,
  background: 'var(--card)',
  padding: 24,
  maxWidth: 760,
};

const kickerStyle: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--muted)',
  marginBottom: 8,
};

const h1Style: React.CSSProperties = {
  fontFamily: 'var(--font-display)',
  fontSize: 28,
  fontWeight: 800,
  letterSpacing: 0,
  margin: 0,
  color: 'var(--ink)',
};

const bodyStyle: React.CSSProperties = {
  fontSize: 14,
  lineHeight: 1.6,
  color: 'var(--muted)',
  margin: '10px 0 20px',
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
  fontWeight: 700,
};
