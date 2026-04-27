// /studio/:slug/access — app visibility + bearer token management.
// v1 scope: visibility toggle (public / private / auth-required),
// bearer-key rotation for auth-required apps. Rotations + creation
// hit the /api/me/apps/:slug backend endpoints that already exist.

import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { WorkspacePageShell } from '../components/WorkspacePageShell';
import { AppHeader } from './MeAppPage';
import { StudioAppTabs } from './StudioAppPage';
import * as api from '../api/client';
import type { AppDetail } from '../lib/types';

type Visibility = 'public' | 'private' | 'auth-required';

export function StudioAppAccessPage() {
  const { slug } = useParams<{ slug: string }>();
  const nav = useNavigate();
  const [app, setApp] = useState<AppDetail | null>(null);
  const [visibility, setVisibility] = useState<Visibility>('public');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    api
      .getApp(slug)
      .then((res) => {
        if (cancelled) return;
        setApp(res);
        const v = (res as AppDetail & { visibility?: Visibility }).visibility;
        if (v) setVisibility(v);
      })
      .catch((err) => {
        if (cancelled) return;
        const status = (err as { status?: number }).status;
        if (status === 404) return nav('/studio', { replace: true });
        if (status === 403) return nav(`/p/${slug}`, { replace: true });
        setError((err as Error).message || 'Failed to load app');
      });
    return () => {
      cancelled = true;
    };
  }, [slug, nav]);

  async function saveVisibility(next: Visibility) {
    if (!slug || next === visibility) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      // Typed as any because the existing client doesn't yet expose a
      // dedicated updateAppVisibility helper — wire through the generic
      // fetch to the same endpoint the BuildPage edit flow uses.
      const res = await fetch(`/api/me/apps/${slug}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ visibility: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setVisibility(next);
      setNotice(`Visibility updated to "${next}".`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <WorkspacePageShell
      mode="studio"
      title={app ? `${app.name} · Access · Studio` : 'Access · Studio'}
    >
      {error && <div style={errorStyle}>{error}</div>}
      {notice && <div style={noticeStyle}>{notice}</div>}
      {app && (
        <>
          <AppHeader app={app} />
          <StudioAppTabs slug={app.slug} active="access" />

          <h2 style={sectionHeader}>Visibility</h2>
          <p style={helpText}>
            Controls who can discover and run your app from the Store.
          </p>

          <div
            role="radiogroup"
            aria-label="Visibility"
            style={{ display: 'grid', gap: 10, maxWidth: 640 }}
            data-testid="studio-access-visibility"
          >
            <VisibilityOption
              value="public"
              current={visibility}
              onChange={saveVisibility}
              saving={saving}
              title="Public"
              desc="Anyone can find and run this app via /apps and /p/:slug."
            />
            <VisibilityOption
              value="auth-required"
              current={visibility}
              onChange={saveVisibility}
              saving={saving}
              title="Auth required"
              desc="Visible in the Store, but callers need a Floom account to run."
            />
            <VisibilityOption
              value="private"
              current={visibility}
              onChange={saveVisibility}
              saving={saving}
              title="Private"
              desc="Only you. Not listed in /apps; only owner can run it."
            />
          </div>

          <h2 style={{ ...sectionHeader, marginTop: 32 }}>Agent tokens</h2>
          <p style={helpText}>
            Use workspace Agent tokens for programmatic callers. Create
            one in Workspace settings and include it as <code>Authorization: Bearer floom_agent_••••••</code>.
          </p>
          <div data-testid="studio-access-keys-stub" style={emptyState}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', marginBottom: 4 }}>
              Coming v1.1
            </div>
            <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0 }}>
              Per-app token scopes arrive after launch. Workspace Agent tokens cover CLI, MCP, HTTP, and CI today.
            </p>
          </div>
        </>
      )}
    </WorkspacePageShell>
  );
}

function VisibilityOption({
  value,
  current,
  onChange,
  saving,
  title,
  desc,
}: {
  value: Visibility;
  current: Visibility;
  onChange: (v: Visibility) => void;
  saving: boolean;
  title: string;
  desc: string;
}) {
  const active = value === current;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      disabled={saving}
      onClick={() => onChange(value)}
      data-testid={`studio-access-option-${value}`}
      style={{
        textAlign: 'left',
        padding: '14px 16px',
        borderRadius: 10,
        border: active ? '2px solid var(--accent)' : '1px solid var(--line)',
        background: active ? 'var(--accent-soft)' : 'var(--card)',
        cursor: saving ? 'wait' : 'pointer',
        fontFamily: 'inherit',
        color: 'var(--ink)',
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 2 }}>
        {title} {active && <span style={{ color: 'var(--accent)' }}>· current</span>}
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>{desc}</div>
    </button>
  );
}

const errorStyle: React.CSSProperties = {
  background: '#fdecea',
  border: '1px solid #f4b7b1',
  color: '#c2321f',
  padding: '10px 14px',
  borderRadius: 8,
  fontSize: 13,
  marginBottom: 20,
};

const noticeStyle: React.CSSProperties = {
  background: '#d7f1e0',
  border: '1px solid #a5d9b7',
  color: '#1f6a3a',
  padding: '10px 14px',
  borderRadius: 8,
  fontSize: 13,
  marginBottom: 20,
};

const sectionHeader: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 700,
  color: 'var(--ink)',
  margin: '20px 0 6px',
};

const helpText: React.CSSProperties = {
  fontSize: 13,
  color: 'var(--muted)',
  margin: '0 0 14px',
  lineHeight: 1.55,
};

const emptyState: React.CSSProperties = {
  border: '1px dashed var(--line)',
  borderRadius: 10,
  padding: '20px',
  background: 'var(--card)',
};
