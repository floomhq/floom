import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { TopBar } from '../components/TopBar';
import { Footer } from '../components/Footer';
import { RouteLoading } from '../components/RouteLoading';
import { getRun } from '../api/client';
import { track } from '../lib/posthog';
import {
  classifyPermalinkLoadError,
  getPermalinkLoadErrorMessage,
  type PermalinkLoadOutcome,
} from '../lib/publicPermalinks';

export function PublicRunPermalinkPage() {
  const { runId } = useParams<{ runId: string }>();
  const navigate = useNavigate();
  const [state, setState] = useState<'loading' | PermalinkLoadOutcome>('loading');

  useEffect(() => {
    if (!runId) {
      setState('not_found');
      return;
    }
    // Analytics (launch-infra #4): share_link_opened fires once per mount,
    // before the getRun resolves. `/r/:runId` always implies a shared run
    // link; `/p/:slug?run=...` mounts are handled inside AppPermalinkPage
    // (not here) and are intentionally out of scope for this task's edit.
    track('share_link_opened', { run_id: runId });
    let cancelled = false;
    setState('loading');
    getRun(runId)
      .then((run) => {
        if (cancelled) return;
        if (!run.app_slug) {
          setState('not_found');
          return;
        }
        navigate(`/p/${run.app_slug}?run=${encodeURIComponent(run.id)}`, { replace: true });
      })
      .catch((err) => {
        if (!cancelled) setState(classifyPermalinkLoadError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [navigate, runId]);

  if (state === 'loading') {
    return (
      <div className="page-root">
        <TopBar compact />
        <main className="main" style={{ maxWidth: 560, margin: '0 auto', paddingTop: 80 }}>
          <RouteLoading variant="embed" />
        </main>
        <Footer />
      </div>
    );
  }

  const retryable = state === 'retryable';

  return (
    <div className="page-root">
      <TopBar compact />
      <main className="main" style={{ paddingTop: 80, textAlign: 'center', maxWidth: 520, margin: '0 auto' }}>
        <h1 style={{ fontSize: 32, fontWeight: 700, margin: '0 0 12px' }}>
          {retryable ? 'Shared run temporarily unavailable' : 'Shared run not found'}
        </h1>
        <p style={{ color: 'var(--muted)', fontSize: 16, margin: '0 0 32px', lineHeight: 1.55 }}>
          {retryable ? (
            getPermalinkLoadErrorMessage('run')
          ) : (
            <>
              We couldn&apos;t find the shared run for{' '}
              <code style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 13 }}>/r/{runId}</code>
              .
            </>
          )}
        </p>
        <div style={{ display: 'inline-flex', gap: 10, flexWrap: 'wrap' }}>
          {retryable ? (
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '10px 20px',
                background: 'var(--accent)',
                color: '#fff',
                border: '1px solid var(--accent)',
                borderRadius: 8,
                fontSize: 14,
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              Try again
            </button>
          ) : null}
          <Link
            to="/apps"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '10px 20px',
              background: retryable ? 'var(--card)' : 'var(--accent)',
              color: retryable ? 'var(--ink)' : '#fff',
              borderRadius: 8,
              border: retryable ? '1px solid var(--line)' : '1px solid var(--accent)',
              fontSize: 14,
              fontWeight: 600,
              textDecoration: 'none',
            }}
          >
            Back to all apps
          </Link>
        </div>
      </main>
      <Footer />
    </div>
  );
}
