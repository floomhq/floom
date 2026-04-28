import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { WorkspaceHeader, WorkspacePageShell } from '../components/WorkspacePageShell';
import { RunAppTabs } from './MeAppRunPage';
import * as api from '../api/client';
import type { AppDetail } from '../lib/types';
import type { TriggerPublic } from '../api/client';

export function MeAppTriggersPage() {
  const { slug = '' } = useParams<{ slug: string }>();
  const [app, setApp] = useState<AppDetail | null>(null);
  const [triggers, setTriggers] = useState<TriggerPublic[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!slug) return;
    api.getApp(slug).then((res) => !cancelled && setApp(res)).catch((err) => !cancelled && setError((err as Error).message));
    api.listMyTriggers().then((res) => {
      if (!cancelled) setTriggers(res.triggers.filter((trigger) => trigger.app_slug === slug));
    }).catch((err) => !cancelled && setError((err as Error).message));
    return () => {
      cancelled = true;
    };
  }, [slug]);

  return (
    <WorkspacePageShell mode="run" title={app ? `${app.name} · Triggers · Floom` : 'Triggers · Floom'}>
      <WorkspaceHeader
        eyebrow="Workspace Run"
        title={`Triggers for ${app?.name || slug}`}
        scope="Triggers run this installed app inside the active workspace. Each workspace configures its own webhooks and schedules."
        actions={
          <>
            <Link to={`/run/apps/${slug}/triggers/schedule`} style={primaryLinkStyle}>Schedule</Link>
            <Link to={`/run/apps/${slug}/triggers/webhook`} style={secondaryLinkStyle}>Webhook</Link>
          </>
        }
      />
      <RunAppTabs slug={slug} active="triggers" />
      <div style={crossLinkStyle}>
        Triggers use workspace BYOK keys. <Link to="/settings/byok-keys" style={inlineLinkStyle}>Workspace BYOK keys</Link>
      </div>
      {error ? <div style={errorStyle}>{error}</div> : null}
      {triggers === null ? (
        <div style={mutedStyle}>Loading triggers...</div>
      ) : triggers.length === 0 ? (
        <div style={emptyStyle}>No triggers configured for this workspace.</div>
      ) : (
        <div style={listStyle}>
          {triggers.map((trigger) => (
            <div key={trigger.id} style={rowStyle}>
              <div>
                <div style={strongStyle}>{trigger.trigger_type === 'schedule' ? 'Schedule' : 'Webhook'} · {trigger.action}</div>
                <div style={mutedStyle}>
                  {trigger.trigger_type === 'schedule' ? trigger.cron_expression : trigger.webhook_url_path}
                </div>
              </div>
              <span style={pillStyle}>{trigger.enabled ? 'Enabled' : 'Paused'}</span>
            </div>
          ))}
        </div>
      )}
    </WorkspacePageShell>
  );
}

export const primaryLinkStyle: React.CSSProperties = {
  border: '1px solid var(--ink)',
  borderRadius: 8,
  padding: '9px 13px',
  background: 'var(--ink)',
  color: '#fff',
  fontSize: 13,
  fontWeight: 700,
  textDecoration: 'none',
};

export const secondaryLinkStyle: React.CSSProperties = {
  border: '1px solid var(--line)',
  borderRadius: 8,
  padding: '9px 13px',
  background: 'var(--card)',
  color: 'var(--ink)',
  fontSize: 13,
  fontWeight: 700,
  textDecoration: 'none',
};

export const crossLinkStyle: React.CSSProperties = {
  border: '1px solid var(--line)',
  borderRadius: 10,
  background: 'var(--card)',
  padding: '12px 14px',
  marginBottom: 18,
  fontSize: 13,
  color: 'var(--muted)',
};

export const inlineLinkStyle: React.CSSProperties = {
  color: 'var(--accent)',
  fontWeight: 700,
  textDecoration: 'none',
};

const listStyle: React.CSSProperties = {
  border: '1px solid var(--line)',
  borderRadius: 12,
  background: 'var(--card)',
  overflow: 'hidden',
};

const rowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 12,
  padding: '14px 16px',
  borderBottom: '1px solid var(--line)',
};

const strongStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 750,
  color: 'var(--ink)',
};

const mutedStyle: React.CSSProperties = {
  fontSize: 13,
  color: 'var(--muted)',
  lineHeight: 1.55,
};

const emptyStyle: React.CSSProperties = {
  border: '1px dashed var(--line)',
  borderRadius: 12,
  background: 'var(--card)',
  padding: 22,
  fontSize: 13,
  color: 'var(--muted)',
};

const pillStyle: React.CSSProperties = {
  border: '1px solid var(--line)',
  borderRadius: 999,
  padding: '3px 8px',
  fontSize: 11,
  fontWeight: 700,
  color: 'var(--muted)',
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
