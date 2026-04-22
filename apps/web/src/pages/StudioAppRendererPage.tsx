// /studio/:slug/renderer — custom renderer upload/management. Reuses
// the existing CustomRendererPanel (see components/CustomRendererPanel.tsx)
// which handles upload, test-render, and delete.

import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { StudioLayout } from '../components/studio/StudioLayout';
import { AppHeader } from './MeAppPage';
import { CustomRendererPanel } from '../components/CustomRendererPanel';
import * as api from '../api/client';
import type { AppDetail, CreatorRun, RendererMeta } from '../lib/types';

export function StudioAppRendererPage() {
  const { slug } = useParams<{ slug: string }>();
  const nav = useNavigate();
  const [app, setApp] = useState<AppDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [latestSuccessfulRun, setLatestSuccessfulRun] = useState<CreatorRun | null>(null);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    setLatestSuccessfulRun(null);
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
    api
      .getAppRuns(slug, 20)
      .then((res) => {
        if (cancelled) return;
        const next =
          res.runs.find((run) => run.status === 'success' && run.outputs !== null) || null;
        setLatestSuccessfulRun(next);
      })
      .catch(() => {
        if (!cancelled) setLatestSuccessfulRun(null);
      });
    return () => {
      cancelled = true;
    };
  }, [slug, nav]);

  return (
    <StudioLayout
      title={app ? `${app.name} · Renderer · Studio` : 'Renderer · Studio'}
      activeAppSlug={slug}
      activeSubsection="renderer"
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
          <h2
            style={{
              fontSize: 14,
              fontWeight: 700,
              color: 'var(--ink)',
              margin: '20px 0 6px',
            }}
          >
            Custom renderer
          </h2>
          <p
            style={{
              fontSize: 13,
              color: 'var(--muted)',
              margin: '0 0 18px',
              lineHeight: 1.55,
              maxWidth: 620,
            }}
          >
            Upload a TSX/React renderer, compile it, and verify the saved
            output here before leaving Studio. The preview uses your latest
            successful run when available, or a deterministic sample output
            when the app has no run history yet.
          </p>
          <div
            style={{
              background: 'var(--card)',
              border: '1px solid var(--line)',
              borderRadius: 12,
              padding: 20,
              maxWidth: 960,
            }}
          >
            <CustomRendererPanel
              slug={app.slug}
              initial={app.renderer ?? null}
              app={app}
              previewRun={latestSuccessfulRun}
              onChange={(next: RendererMeta | null) =>
                setApp((current) => (current ? { ...current, renderer: next } : current))
              }
            />
          </div>
        </>
      )}
    </StudioLayout>
  );
}
