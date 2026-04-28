import { useParams } from 'react-router-dom';
import { WorkspacePageShell } from '../components/WorkspacePageShell';
import { StudioAppTabs } from './StudioAppPage';

export function StudioAppFeedbackPage() {
  const { slug = '' } = useParams<{ slug: string }>();

  return (
    <WorkspacePageShell mode="studio" title="Feedback · Studio">
      <StudioAppTabs slug={slug} active="feedback" />
      <section style={cardStyle}>
        <div style={kickerStyle}>Studio</div>
        <h1 style={h1Style}>Feedback</h1>
        <p style={bodyStyle}>
          User feedback and review signals for this app will appear here after launch. Public app reviews remain on the app page.
        </p>
      </section>
    </WorkspacePageShell>
  );
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
  margin: '10px 0 0',
  maxWidth: 620,
};
