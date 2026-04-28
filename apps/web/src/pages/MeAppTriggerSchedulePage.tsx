import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { WorkspaceHeader, WorkspacePageShell } from '../components/WorkspacePageShell';
import { RunAppTabs } from './MeAppRunPage';
import * as api from '../api/client';
import { crossLinkStyle, inlineLinkStyle, primaryLinkStyle, secondaryLinkStyle } from './MeAppTriggersPage';

export function MeAppTriggerSchedulePage() {
  const { slug = '' } = useParams<{ slug: string }>();
  const [action, setAction] = useState('run');
  const [cron, setCron] = useState('0 9 * * 1');
  const [tz, setTz] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api.createScheduleTrigger(slug, { action, cron_expression: cron, tz });
      setStatus('Schedule trigger created.');
      setError(null);
    } catch (err) {
      setError((err as Error).message || 'Failed to create schedule trigger');
    }
  }

  return (
    <WorkspacePageShell mode="run" title="Schedule trigger | Floom">
      <WorkspaceHeader
        eyebrow="Workspace Run"
        title="Schedule trigger"
        scope="Create a cron-based trigger for this installed app."
        actions={<Link to={`/run/apps/${slug}/triggers`} style={secondaryLinkStyle}>Back to triggers</Link>}
      />
      <RunAppTabs slug={slug} active="triggers" />
      <div style={crossLinkStyle}>Runs execute with workspace BYOK keys. <Link to="/settings/byok-keys" style={inlineLinkStyle}>Manage BYOK keys</Link></div>
      {status ? <div style={noticeStyle}>{status}</div> : null}
      {error ? <div style={errorStyle}>{error}</div> : null}
      <form onSubmit={submit} style={cardStyle}>
        <label style={labelStyle}>Action<input value={action} onChange={(e) => setAction(e.target.value)} style={inputStyle} /></label>
        <label style={labelStyle}>Cron expression<input value={cron} onChange={(e) => setCron(e.target.value)} style={inputStyle} /></label>
        <label style={labelStyle}>Timezone<input value={tz} onChange={(e) => setTz(e.target.value)} style={inputStyle} /></label>
        <button type="submit" style={primaryLinkStyle}>Create schedule</button>
      </form>
    </WorkspacePageShell>
  );
}

const cardStyle: React.CSSProperties = {
  border: '1px solid var(--line)',
  borderRadius: 12,
  background: 'var(--card)',
  padding: 20,
  display: 'grid',
  gap: 12,
  maxWidth: 620,
};

const labelStyle: React.CSSProperties = {
  display: 'grid',
  gap: 6,
  fontSize: 12,
  fontWeight: 700,
  color: 'var(--muted)',
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

const noticeStyle: React.CSSProperties = {
  border: '1px solid #bbf7d0',
  background: '#f0fdf4',
  color: '#166534',
  borderRadius: 8,
  padding: '10px 12px',
  fontSize: 13,
  marginBottom: 14,
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
