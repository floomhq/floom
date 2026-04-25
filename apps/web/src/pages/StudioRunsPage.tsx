import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { StudioLayout } from '../components/studio/StudioLayout';
import { StudioSignedOutState } from '../components/studio/StudioSignedOutState';
import { useSession } from '../hooks/useSession';
import * as api from '../api/client';
import type { StudioActivityRun } from '../lib/types';
import { formatTime } from '../lib/time';
import { AppIcon } from '../components/AppIcon';

export function StudioRunsPage() {
  const { data: session } = useSession();
  const signedOutPreview = !!session && session.cloud_mode && session.user.is_local;
  const [runs, setRuns] = useState<StudioActivityRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (signedOutPreview) return;
    let cancelled = false;
    api
      .getStudioActivity(100)
      .then((response) => {
        if (!cancelled) setRuns(response.runs);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load runs');
      });
    return () => {
      cancelled = true;
    };
  }, [signedOutPreview]);

  return (
    <StudioLayout
      title="All runs · Studio · Floom"
      allowSignedOutShell={signedOutPreview}
      contentStyle={{
        maxWidth: 1180,
        padding: '24px 28px 96px',
      }}
    >
      {signedOutPreview ? (
        <StudioSignedOutState />
      ) : (
        <div data-testid="studio-runs-page" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <header style={headerStyle}>
            <div>
              <div style={eyebrowStyle}>Personal · All runs</div>
              <h1 style={titleStyle}>Latest across all apps</h1>
              <p style={subtitleStyle}>Who ran what, where they ran it from, and how long it took.</p>
            </div>
            <Link to="/studio" style={backLinkStyle}>
              Back home →
            </Link>
          </header>

          {error ? <div style={errorStyle}>{error}</div> : null}

          {runs === null ? (
            <div style={loadingStyle}>Loading runs…</div>
          ) : runs.length === 0 ? (
            <div data-testid="studio-runs-empty" style={emptyStyle}>
              Nothing here yet — be the first.
            </div>
          ) : (
            <div data-testid="studio-runs-list" style={listStyle}>
              {runs.map((run, index) => (
                <div
                  key={run.id}
                  style={{
                    ...rowStyle,
                    borderBottom: index === runs.length - 1 ? 'none' : rowStyle.borderBottom,
                  }}
                >
                  <span style={iconWrapStyle}>
                    <AppIcon slug={run.app_slug} size={18} />
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div style={rowTitleStyle}>
                      <span style={strongStyle}>{run.user_label}</span> ran{' '}
                      <Link to={`/studio/${run.app_slug}`} style={appLinkStyle}>
                        {run.app_name}
                      </Link>{' '}
                      from <span style={{ color: 'var(--muted)' }}>{run.source_label}</span>
                    </div>
                    <div style={rowMetaStyle}>
                      <span>{formatTime(run.started_at)}</span>
                      <span>·</span>
                      <span>{formatDuration(run.duration_ms)}</span>
                      {run.status !== 'success' ? (
                        <>
                          <span>·</span>
                          <span style={{ color: '#b42318' }}>{run.status}</span>
                        </>
                      ) : null}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </StudioLayout>
  );
}

function formatDuration(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s`;
}

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 16,
  flexWrap: 'wrap',
};

const eyebrowStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color: 'var(--accent)',
};

const titleStyle: CSSProperties = {
  margin: '8px 0 0',
  fontFamily: 'var(--font-display)',
  fontSize: 34,
  fontWeight: 400,
  letterSpacing: '-0.03em',
  lineHeight: 1.05,
  color: 'var(--ink)',
};

const subtitleStyle: CSSProperties = {
  margin: '10px 0 0',
  maxWidth: 620,
  fontSize: 14,
  lineHeight: 1.65,
  color: 'var(--muted)',
};

const backLinkStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: 'var(--accent)',
  textDecoration: 'none',
};

const errorStyle: CSSProperties = {
  padding: '14px 16px',
  borderRadius: 16,
  border: '1px solid #f4b7b1',
  background: '#fdecea',
  color: '#5c2d26',
  fontSize: 13.5,
  lineHeight: 1.6,
};

const loadingStyle: CSSProperties = {
  padding: '18px',
  borderRadius: 18,
  border: '1px dashed var(--line)',
  background: 'var(--bg)',
  color: 'var(--muted)',
  fontSize: 13,
};

const emptyStyle: CSSProperties = {
  padding: '24px 18px',
  borderRadius: 18,
  border: '1px dashed var(--line)',
  background: 'var(--bg)',
  color: 'var(--muted)',
  fontSize: 13,
};

const listStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  borderRadius: 20,
  border: '1px solid var(--line)',
  overflow: 'hidden',
  background: 'var(--card)',
};

const rowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '40px minmax(0, 1fr)',
  gap: 14,
  alignItems: 'center',
  padding: '16px 18px',
  borderBottom: '1px solid var(--line)',
};

const iconWrapStyle: CSSProperties = {
  width: 40,
  height: 40,
  borderRadius: 14,
  border: '1px solid var(--line)',
  background: 'var(--bg)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const rowTitleStyle: CSSProperties = {
  fontSize: 14,
  lineHeight: 1.55,
  color: 'var(--ink)',
};

const rowMetaStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  marginTop: 4,
  fontSize: 12,
  color: 'var(--muted)',
};

const strongStyle: CSSProperties = {
  fontWeight: 700,
};

const appLinkStyle: CSSProperties = {
  fontWeight: 700,
  color: 'var(--ink)',
  textDecoration: 'none',
};
