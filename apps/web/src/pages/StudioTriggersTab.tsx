import { Link, useParams } from 'react-router-dom';
import { WorkspacePageShell } from '../components/WorkspacePageShell';
import { StudioAppTabs } from './StudioAppPage';

export function StudioAppTriggersPage() {
  const { slug = '' } = useParams<{ slug: string }>();

  return (
    <WorkspacePageShell mode="studio" title="Triggers · Studio">
      <StudioAppTabs slug={slug} active="triggers" />
      <section style={cardStyle}>
        <div style={kickerStyle}>Studio</div>
        <h1 style={h1Style}>Triggers are configured in Run</h1>
        <p style={bodyStyle}>
          Creators publish the app once. Each workspace configures webhooks and schedules from Run mode after installing the app.
        </p>
        <Link to={`/run/apps/${slug}/triggers`} style={primaryLinkStyle}>
          Open Run triggers
        </Link>
      </section>
    </WorkspacePageShell>
  );
}

export function StudioTriggersTab() {
  return <StudioAppTriggersPage />;
}

const cardStyle: React.CSSProperties = {
  border: '1px solid var(--line)',
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
  maxWidth: 620,
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
