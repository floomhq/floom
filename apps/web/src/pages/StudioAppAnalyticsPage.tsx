// /studio/:slug/analytics — intentional stub. Shows a mock chart so
// creators can see where analytics will live post-v1.1. We explicitly
// render "Coming v1.1" so nobody mistakes this for a bug.

import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { StudioLayout } from '../components/studio/StudioLayout';
import { AppHeader } from './MeAppPage';
import * as api from '../api/client';
import type { AppDetail } from '../lib/types';

export function StudioAppAnalyticsPage() {
  const { slug } = useParams<{ slug: string }>();
  const nav = useNavigate();
  const [app, setApp] = useState<AppDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    api
      .getApp(slug)
      .then((res) => !cancelled && setApp(res))
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

  return (
    <StudioLayout
      title={app ? `${app.name} · Analytics · Studio` : 'Analytics · Studio'}
      activeAppSlug={slug}
      activeSubsection="analytics"
    >
      {error && (
        <div
          style={{
            background: '#fdecea',
            border: '1px solid #f4b7b1',
            color: '#c2321f',
            padding: '10px 14px',
            borderRadius: 8,
            fontSize: 13,
            marginBottom: 20,
          }}
        >
          {error}
        </div>
      )}
      {app && (
        <>
          <AppHeader app={app} />

          <div
            data-testid="studio-analytics-stub"
            style={{
              background: 'var(--card)',
              border: '1px dashed var(--line)',
              borderRadius: 12,
              padding: '32px 28px',
              maxWidth: 720,
              margin: '20px 0',
              position: 'relative',
            }}
          >
            <div
              style={{
                display: 'inline-block',
                padding: '3px 8px',
                borderRadius: 4,
                background: 'var(--accent-soft)',
                color: 'var(--accent)',
                fontSize: 10,
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                marginBottom: 12,
              }}
            >
              Coming v1.1
            </div>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--ink)', margin: '0 0 6px' }}>
              Usage analytics
            </h2>
            <p
              style={{
                fontSize: 13,
                color: 'var(--muted)',
                margin: '0 0 24px',
                lineHeight: 1.55,
                maxWidth: 560,
              }}
            >
              Runs per day, p50 / p95 latency, error rate, unique callers,
              and top actions. Until then, the Runs tab has the raw list.
            </p>

            <MockChart />
          </div>
        </>
      )}
    </StudioLayout>
  );
}

function MockChart() {
  // Deterministic bars so the design is stable across reloads.
  const bars = [42, 58, 34, 71, 88, 63, 52, 79, 94, 68, 81, 90, 75, 86];
  const max = Math.max(...bars);
  return (
    <div
      aria-hidden="true"
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        gap: 6,
        height: 120,
        padding: '12px 0',
        borderTop: '1px solid var(--line)',
        opacity: 0.6,
      }}
    >
      {bars.map((v, i) => (
        <div
          key={i}
          style={{
            flex: 1,
            height: `${(v / max) * 100}%`,
            background: 'var(--accent)',
            borderRadius: '2px 2px 0 0',
            minWidth: 0,
          }}
        />
      ))}
    </div>
  );
}
