// /p/:slug — product page (user view). Rebuilt 2026-04-17 to match
// wireframes.floom.dev v11 Screen 3. Single scrolling page (no tabs):
// breadcrumb -> hero + meta card -> how-it-works strip -> about +
// full ratings widget -> connectors row -> inline run surface.
//
// Schedule drawer and ChatGPT/Notion/Terminal connectors are explicit
// "coming soon" stubs (schedule needs job queue UI; the provider
// connectors ship after v1 per project_floom_layers.md).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { TopBar } from '../components/TopBar';
import { Footer } from '../components/Footer';
import { RunSurface } from '../components/runner/RunSurface';
import { AppIcon } from '../components/AppIcon';
import { AppReviews } from '../components/AppReviews';
import { FeedbackButton } from '../components/FeedbackButton';
import { DescriptionMarkdown } from '../components/DescriptionMarkdown';
import { getApp, getAppReviews, getRun, ApiError } from '../api/client';
import { useSession } from '../hooks/useSession';
import type { ActionSpec, AppDetail, ReviewSummary, RunRecord } from '../lib/types';
import {
  buildPublicRunPath,
  classifyPermalinkLoadError,
  getPermalinkLoadErrorMessage,
  type PermalinkLoadOutcome,
} from '../lib/publicPermalinks';

// Map of known app slugs to GitHub repo URLs. Only slugs whose example
// directory lives in examples/ are linked; stub-only apps (floom.yaml with
// no server code) were removed in the 2026-04-17 bloat cut.
const GITHUB_REPOS: Record<string, string> = {
  'blast-radius': 'https://github.com/floomhq/floom-monorepo/tree/main/examples/blast-radius',
  'claude-wrapped': 'https://github.com/floomhq/floom-monorepo/tree/main/examples/claude-wrapped',
  'dep-check': 'https://github.com/floomhq/floom-monorepo/tree/main/examples/dep-check',
  'hook-stats': 'https://github.com/floomhq/floom-monorepo/tree/main/examples/hook-stats',
  'session-recall': 'https://github.com/floomhq/floom-monorepo/tree/main/examples/session-recall',
  'ig-nano-scout': 'https://github.com/floomhq/floom-monorepo/tree/main/examples/ig-nano-scout',
};

type ComingSoonTarget = 'chatgpt' | 'notion' | 'terminal' | 'schedule';

export function AppPermalinkPage() {
  const { slug } = useParams<{ slug: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const runIdFromUrl = searchParams.get('run');
  // Gate "Open in Studio" — only the app owner sees the creator bridge.
  // Previously ANY authenticated user saw a link into the creator dashboard,
  // which was a permission leak (audit 2026-04-18). Studio restructure locks
  // this to owners only.
  const { data: session } = useSession();
  const sessionUserId = session?.user?.id ?? null;

  const [app, setApp] = useState<AppDetail | null>(null);
  const [summary, setSummary] = useState<ReviewSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [loadFailure, setLoadFailure] = useState<PermalinkLoadOutcome | null>(null);
  const [comingSoon, setComingSoon] = useState<ComingSoonTarget | null>(null);
  // Fix 4 (2026-04-19): tiny self-dismissing toast for the Share button.
  const [shareToast, setShareToast] = useState(false);

  // v16 restructure: /p/:slug is tabbed now (Run / About / Install / Source).
  // Run is the default — the previous product-page layout made users scroll
  // past marketing copy to find the actual run surface. Shared-run URLs
  // (/p/:slug?run=<id>) auto-land on Run.
  type PTab = 'run' | 'about' | 'install' | 'source';
  const initialTab: PTab = searchParams.get('tab') as PTab | null ?? 'run';
  const [activeTab, setActiveTab] = useState<PTab>(
    ['run', 'about', 'install', 'source'].includes(initialTab) ? initialTab : 'run',
  );
  // Run prefetched from /api/run/:id when the URL contains ?run=<id>. Lets
  // RunSurface hydrate directly into the `done` phase for shared links.
  const [initialRun, setInitialRun] = useState<RunRecord | null>(null);
  // initialRunLoading avoids rendering the RunSurface in `ready` phase (which
  // would flash the empty form) while the run is being fetched.
  const [initialRunLoading, setInitialRunLoading] = useState<boolean>(!!runIdFromUrl);
  // 2026-04-20 (P2 #147): a shared link with a dead run-id used to silently
  // fall through to the empty form, making the page look broken ("I clicked
  // a link and got a blank form"). Surface a gentle amber "Run not found"
  // card with a CTA to open the app fresh instead.
  const [runNotFound, setRunNotFound] = useState(false);

  // v6-align 2026-04-20: when a run is active (?run=<id> in URL or
  // initialRun resolved), collapse the hero to a thin strip so the run
  // output gets ~60% more vertical room. Federico flagged the hero as
  // visual bloat during active runs. User can click "View details" to
  // re-expand in place; the tab bar stays rendered below in both states.
  const [heroExpanded, setHeroExpanded] = useState(false);

  useEffect(() => {
    if (!slug) {
      setNotFound(true);
      setLoadFailure(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setNotFound(false);
    setLoadFailure(null);
    getApp(slug)
      .then((a) => {
        setApp(a);
        setLoading(false);
      })
      .catch((err) => {
        const outcome = classifyPermalinkLoadError(err);
        setNotFound(outcome === 'not_found');
        setLoadFailure(outcome === 'retryable' ? outcome : null);
        setLoading(false);
      });
    // Fetch review summary separately so hero can show it without waiting
    // on AppReviews mounting.
    getAppReviews(slug, 1)
      .then((res) => setSummary(res.summary))
      .catch(() => setSummary({ count: 0, avg: 0 }));
  }, [slug]);

  // /p/:slug?run=<id> — fetch the run and hydrate RunSurface read-only.
  // Scoped to this slug so a run-id from a different app is silently
  // ignored (prevents accidentally mounting someone else's run into an
  // unrelated page). If the run is owned by a private (auth-required)
  // app that this visitor can't see, GET /api/run/:id returns 401 and we
  // just drop the initial-run state, showing the empty form instead.
  useEffect(() => {
    if (!slug || !runIdFromUrl) {
      setInitialRun(null);
      setInitialRunLoading(false);
      setRunNotFound(false);
      return;
    }
    let cancelled = false;
    setInitialRunLoading(true);
    setRunNotFound(false);
    getRun(runIdFromUrl)
      .then((run) => {
        if (cancelled) return;
        if (run.app_slug && run.app_slug !== slug) {
          // Mismatch: clear the ?run param and fall through to the empty form.
          setInitialRun(null);
          setSearchParams(
            (prev) => {
              const next = new URLSearchParams(prev);
              next.delete('run');
              return next;
            },
            { replace: true },
          );
          return;
        }
        // Only restore finished runs. In-flight runs aren't deep-linkable
        // yet; the RunSurface stream/poll path owns that UI surface.
        if (['success', 'error', 'timeout'].includes(run.status)) {
          setInitialRun(run);
        } else {
          setInitialRun(null);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setInitialRun(null);
        // 2026-04-20 (P2 #147): 404 → show "Run not found" inline card.
        // Everything else (401 on a private app, network blip) still falls
        // through to the empty form — those aren't a user-visible bug the
        // way a dead run-id in a shared link is.
        if (err instanceof ApiError && err.status === 404) {
          setRunNotFound(true);
        }
      })
      .finally(() => {
        if (!cancelled) setInitialRunLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug, runIdFromUrl, setSearchParams]);

  const handleResetInitialRun = useCallback(() => {
    setInitialRun(null);
    setRunNotFound(false);
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('run');
        return next;
      },
      { replace: true },
    );
  }, [setSearchParams]);

  // SEO meta
  useEffect(() => {
    if (!app) return;
    document.title = `${app.name} | Floom`;
    const setMeta = (name: string, content: string, prop = false) => {
      const attr = prop ? 'property' : 'name';
      let el = document.querySelector(`meta[${attr}="${name}"]`);
      if (!el) {
        el = document.createElement('meta');
        el.setAttribute(attr, name);
        document.head.appendChild(el);
      }
      el.setAttribute('content', content);
    };
    setMeta('description', app.description);
    setMeta('og:title', `${app.name} | Floom`, true);
    setMeta('og:description', app.description, true);
    setMeta('og:url', `${window.location.origin}/p/${app.slug}`, true);
    setMeta('og:type', 'website', true);
    // Per-app dynamic OG card (served by /og/:slug.svg on the same origin).
    setMeta('og:image', `${window.location.origin}/og/${app.slug}.svg`, true);
    setMeta('twitter:image', `${window.location.origin}/og/${app.slug}.svg`);
    setMeta('twitter:title', `${app.name} | Floom`);
    setMeta('twitter:description', app.description);

    const existing = document.getElementById('jsonld-app');
    if (existing) existing.remove();
    const script = document.createElement('script');
    script.id = 'jsonld-app';
    script.type = 'application/ld+json';
    script.textContent = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: app.name,
      description: app.description,
      applicationCategory: app.category || 'UtilitiesApplication',
      url: `https://preview.floom.dev/p/${app.slug}`,
      author: {
        '@type': 'Person',
        name: app.author_display || app.author || 'floomhq',
      },
    });
    document.head.appendChild(script);

    return () => {
      document.title = 'Floom: production layer for AI apps';
      const s = document.getElementById('jsonld-app');
      if (s) s.remove();
    };
  }, [app]);

  // First N manifest actions drive the "how it works" strip (ingest order
  // deprioritizes /health). Falls back to the raw `actions` list for v1 apps.
  const HOW_IT_WORKS_MAX = 6;
  const howItWorks = useMemo<Array<{ label: string; description?: string }>>(() => {
    if (!app) return [];
    const entries = Object.entries(app.manifest?.actions ?? {}) as Array<[string, ActionSpec]>;
    if (entries.length > 0) {
      return entries.slice(0, HOW_IT_WORKS_MAX).map(([, spec]) => ({
        label: spec.label,
        description: spec.description,
      }));
    }
    return (app.actions || []).slice(0, HOW_IT_WORKS_MAX).map((name) => ({ label: name }));
  }, [app]);

  const createdByLabel = useMemo(() => {
    if (!app) return null;
    if (app.author_display && app.author_display.trim()) return app.author_display.trim();
    if (app.author) {
      const a = app.author;
      return a.length > 22 ? `@${a.slice(0, 20)}…` : `@${a}`;
    }
    return null;
  }, [app]);

  // Hero version meta row: "v0.1.0 · by @handle · 2d ago · stable".
  // Fix 1 (2026-04-19): surface app release version to disambiguate from
  // the uuid-action "Version" selector (now "UUID format") and give users
  // a publish-date / stability signal.
  const heroHandle = useMemo(() => {
    if (!app) return null;
    const raw =
      (app.creator_handle && app.creator_handle.trim()) ||
      (app.author_display && app.author_display.replace(/^@/, '').trim()) ||
      (app.author && app.author.trim()) ||
      null;
    if (!raw) return null;
    return raw.length > 22 ? `${raw.slice(0, 20)}…` : raw;
  }, [app]);

  const publishedRelative = useMemo(() => {
    if (!app?.published_at) return null;
    return formatRelativeTime(app.published_at);
  }, [app]);

  if (loading) {
    // CLS fix (2026-04-18): previous loading state was a ~60px paragraph,
    // which caused a ~600px layout shift when the hero + meta card + tabs +
    // RunSurface rendered. Lighthouse recorded CLS 0.486 on /p/:slug. The
    // skeleton below matches the real layout's above-the-fold height so the
    // transition from loading → loaded produces near-zero CLS.
    return (
      <div className="page-root">
        <TopBar />
        <main
          style={{ padding: '24px 24px 80px', maxWidth: 1200, margin: '0 auto' }}
          data-testid="permalink-page"
          aria-busy="true"
        >
          <div style={{ height: 32, marginBottom: 28 }} />
          <section style={{ marginBottom: 40 }}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '96px minmax(0, 1fr) 280px',
                gap: 28,
                alignItems: 'start',
              }}
              className="permalink-hero-grid"
            >
              <div
                style={{
                  width: 96,
                  height: 96,
                  borderRadius: 22,
                  background: 'var(--accent-soft, var(--bg))',
                  border: '1px solid var(--accent-border, var(--line))',
                }}
              />
              <div style={{ minHeight: 240 }}>
                <div
                  style={{
                    height: 44,
                    width: '60%',
                    borderRadius: 6,
                    background: 'var(--line)',
                    opacity: 0.35,
                    marginBottom: 12,
                  }}
                />
                <div
                  style={{
                    height: 14,
                    width: '30%',
                    borderRadius: 4,
                    background: 'var(--line)',
                    opacity: 0.25,
                    marginBottom: 20,
                  }}
                />
                <div style={{ minHeight: 30, marginBottom: 14 }} />
                <div
                  style={{
                    height: 72,
                    borderRadius: 6,
                    background: 'var(--line)',
                    opacity: 0.18,
                    marginBottom: 24,
                  }}
                />
                <div style={{ height: 44 }} />
              </div>
              <div
                style={{
                  minHeight: 260,
                  background: 'var(--card)',
                  border: '1px solid var(--line)',
                  borderRadius: 14,
                }}
              />
            </div>
          </section>
          <div style={{ height: 46, borderBottom: '1px solid var(--line)', marginBottom: 24 }} />
          <section
            style={{
              background: 'var(--card)',
              border: '1px solid var(--line)',
              borderRadius: 14,
              padding: '28px 24px',
              minHeight: 320,
              marginBottom: 32,
            }}
          >
            <p style={{ color: 'var(--muted)', fontSize: 13, padding: 24, textAlign: 'center' }}>
              Loading...
            </p>
          </section>
        </main>
        <Footer />
      </div>
    );
  }

  if (notFound || !app) {
    const retryable = loadFailure === 'retryable';
    return (
      <div className="page-root">
        <TopBar />
        <main className="main" style={{ paddingTop: 80, textAlign: 'center', maxWidth: 480, margin: '0 auto' }}>
          <h1 style={{ fontSize: 32, fontWeight: 700, margin: '0 0 12px' }}>
            {retryable ? 'App temporarily unavailable' : '404'}
          </h1>
          <p style={{ color: 'var(--muted)', fontSize: 16, margin: '0 0 32px' }}>
            {retryable ? (
              getPermalinkLoadErrorMessage('app')
            ) : (
              <>
                No app found at{' '}
                <code style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 13 }}>/p/{slug}</code>
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

  const mcpEndpoint = `https://preview.floom.dev/mcp/app/${app.slug}`;
  const httpEndpoint = `https://preview.floom.dev/api/run`;
  const githubRepo = GITHUB_REPOS[app.slug];
  const firstAction = Object.keys(app.manifest?.actions ?? {})[0] || app.actions?.[0] || 'run';
  const curlExample = `curl -X POST ${httpEndpoint} \\
  -H "Content-Type: application/json" \\
  -d '{"app_slug":"${app.slug}","action":"${firstAction}","inputs":{}}'`;
  const cliExample = `floom run ${app.slug}`;

  // Upgrade 4 (2026-04-19): compact TopBar when a run is active so the
  // output gets more vertical room. True whenever ?run=<id> is present
  // (shared-run hydration path) OR we have a resolved initialRun in
  // state. Single-source-of-truth read so the flag flips back to false
  // as soon as the user clears the shared-run banner.
  const topBarCompact = Boolean(runIdFromUrl || initialRun);

  return (
    <div className="page-root">
      <TopBar compact={topBarCompact} />

      <main
        style={{ padding: '24px 24px 80px', maxWidth: 1200, margin: '0 auto' }}
        data-testid="permalink-page"
      >
        {/* Breadcrumb row */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
            padding: '12px 16px',
            borderBottom: '1px solid var(--line)',
            marginBottom: 28,
            fontSize: 12,
            color: 'var(--muted)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <Link to="/apps" style={{ color: 'var(--muted)', textDecoration: 'none' }}>
              floom
            </Link>
            <Chevron />
            <Link to="/apps" style={{ color: 'var(--muted)', textDecoration: 'none' }}>
              store
            </Link>
            {app.category && (
              <>
                <Chevron />
                <span>{app.category}</span>
              </>
            )}
            <Chevron />
            <span style={{ color: 'var(--ink)', fontWeight: 500 }}>{app.name}</span>
          </div>
          {app.author && sessionUserId && app.author === sessionUserId && (
            <Link
              to={`/studio/${app.slug}`}
              data-testid="open-in-studio"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                color: 'var(--muted)',
                textDecoration: 'none',
                fontWeight: 500,
                fontSize: 13,
              }}
            >
              Open in Studio <ArrowRight />
            </Link>
          )}
        </div>

        {/* v6-align 2026-04-20: collapsed hero strip when a run is active.
            Shows a compact app-identity row with a "View details" toggle so
            the full hero is one click away. The tab bar below still renders
            and carries the primary nav during an active run. Federico
            flagged the full hero as visual bloat during runs. */}
        {topBarCompact && !heroExpanded && (
          <section
            data-testid="permalink-hero-collapsed"
            style={{
              marginBottom: 20,
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              padding: '10px 14px',
              border: '1px solid var(--line)',
              borderRadius: 12,
              background: 'var(--card)',
              boxShadow: '0 1px 2px rgba(15, 23, 42, 0.03)',
            }}
          >
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 10,
                border: '1px solid var(--accent-border, var(--line))',
                background: 'var(--accent-soft, var(--bg))',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <AppIcon slug={app.slug} size={20} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 15,
                  fontWeight: 700,
                  color: 'var(--ink)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {app.name}
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--muted)',
                  fontFamily: 'JetBrains Mono, monospace',
                }}
              >
                v{app.version ?? '0.1.0'}
                {heroHandle && ` · by @${heroHandle}`}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setHeroExpanded(true)}
              data-testid="permalink-hero-expand"
              style={{
                padding: '7px 12px',
                border: '1px solid var(--line)',
                background: 'var(--card)',
                color: 'var(--muted)',
                borderRadius: 8,
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: 'inherit',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                whiteSpace: 'nowrap',
              }}
            >
              View details <ChevronDown />
            </button>
          </section>
        )}

        {/* Hero — full form. Hidden in collapsed state; shown by default
            otherwise, or when the user has clicked "View details". */}
        {(!topBarCompact || heroExpanded) && (
        <section data-testid="permalink-hero" style={{ marginBottom: 40 }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '96px minmax(0, 1fr) 280px',
              gap: 28,
              alignItems: 'start',
            }}
            className="permalink-hero-grid"
          >
            <div
              style={{
                width: 96,
                height: 96,
                borderRadius: 22,
                border: '1px solid var(--accent-border, var(--line))',
                background: 'var(--accent-soft, var(--bg))',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--accent)',
              }}
            >
              <AppIcon slug={app.slug} size={56} />
            </div>

            <div>
              <h1
                style={{
                  fontSize: 40,
                  fontWeight: 700,
                  margin: '0 0 6px',
                  color: 'var(--ink)',
                  letterSpacing: '-0.02em',
                  lineHeight: 1.1,
                }}
              >
                {app.name}
              </h1>
              <div
                data-testid="hero-version-meta"
                style={{
                  fontSize: 13,
                  color: 'var(--muted)',
                  marginBottom: 12,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  flexWrap: 'wrap',
                }}
              >
                <span data-testid="hero-version">v{app.version ?? '0.1.0'}</span>
                {heroHandle && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span data-testid="hero-handle">by @{heroHandle}</span>
                  </>
                )}
                {publishedRelative && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span data-testid="hero-published">{publishedRelative}</span>
                  </>
                )}
                <>
                  <span aria-hidden="true">·</span>
                  <span data-testid="hero-version-status">{app.version_status ?? 'stable'}</span>
                </>
              </div>

              {/* Rating row. CLS fix (2026-04-18): reserve min-height 30px
                  so the CTA buttons below don't jump when getAppReviews()
                  resolves. Apps with 0 ratings get an empty reserved slot;
                  when summary.count > 0 the stars + text fill the same box. */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  flexWrap: 'wrap',
                  marginBottom: 14,
                  minHeight: 30,
                }}
              >
                {summary && summary.count > 0 && (
                  <>
                    <StarsRow value={summary.avg} size={16} />
                    <span style={{ fontSize: 13, color: 'var(--muted)' }}>
                      {summary.avg.toFixed(1)} · {summary.count} rating
                      {summary.count === 1 ? '' : 's'}
                    </span>
                  </>
                )}
              </div>

              {/* Upgrade 3 (2026-04-19): markdown-enabled description. */}
              <DescriptionMarkdown
                description={app.description}
                testId="hero-description"
              />

              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <a
                  href="#run"
                  data-testid="cta-run"
                  style={{
                    /* v6-align 2026-04-20: inset highlight + soft outer
                       shadow per v6 .btn-accent (wireframes-floom/v6.html
                       L168-174). Separates the primary Run CTA from the
                       neutral "Add to your tools" and ghost "Share". */
                    padding: '11px 22px',
                    background: 'var(--accent)',
                    color: '#fff',
                    border: '1px solid var(--accent)',
                    borderRadius: 10,
                    fontSize: 14,
                    fontWeight: 600,
                    textDecoration: 'none',
                    boxShadow:
                      '0 1px 2px rgba(5, 150, 105, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.2)',
                    transition: 'background 0.15s ease, box-shadow 0.15s ease',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  Run {app.name}
                </a>
                {/* Fix 4 (2026-04-19): wire the 2 previously-dead CTAs.
                    "Add to your tools" switches to the Install tab (where
                    the MCP connector card lives). Share copies the URL
                    and pops a toast instead of a silent write.
                    2026-04-20 (P2 #148): Schedule was removed entirely.
                    Don't dangle dead affordances — it used to open a
                    ComingSoonModal which users read as broken UI. It'll
                    come back when the job-queue UI lands (P2 v1.1). */}
                <button
                  type="button"
                  data-testid="cta-add-to-tools"
                  onClick={() => {
                    setActiveTab('install');
                    setSearchParams(
                      (prev) => {
                        const next = new URLSearchParams(prev);
                        next.set('tab', 'install');
                        return next;
                      },
                      { replace: true },
                    );
                    // Defer the anchor scroll until the tab has swapped content.
                    requestAnimationFrame(() => {
                      const el = document.getElementById('connectors');
                      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    });
                  }}
                  style={{
                    padding: '11px 18px',
                    border: '1px solid var(--line)',
                    borderRadius: 10,
                    fontSize: 14,
                    fontWeight: 600,
                    color: 'var(--ink)',
                    background: 'var(--card)',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  Add to your tools <ChevronDown />
                </button>
                <button
                  type="button"
                  data-testid="cta-share"
                  onClick={() => {
                    try {
                      const currentUrl = new URL(window.location.href);
                      const currentRunId = currentUrl.searchParams.get('run');
                      const shareUrl = currentRunId
                        ? `${window.location.origin}${buildPublicRunPath(currentRunId)}`
                        : currentUrl.toString();
                      void navigator.clipboard
                        .writeText(shareUrl)
                        .then(() => {
                          setShareToast(true);
                          window.setTimeout(() => setShareToast(false), 1800);
                        });
                    } catch {
                      /* ignore */
                    }
                  }}
                  style={{
                    padding: '11px 14px',
                    border: '1px solid transparent',
                    borderRadius: 10,
                    fontSize: 14,
                    fontWeight: 500,
                    color: 'var(--muted)',
                    background: 'transparent',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  <ShareIcon /> Share
                </button>
              </div>
            </div>

            {/* Meta card. CLS fix (2026-04-18): min-height so the hero
                row height is stable whether or not the optional rows
                (Rating, Runtime, Source) render. */}
            <aside
              style={{
                background: 'var(--card)',
                border: '1px solid var(--line)',
                borderRadius: 14,
                padding: 20,
                fontSize: 13,
                color: 'var(--muted)',
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
                minHeight: 260,
              }}
              data-testid="meta-card"
            >
              {summary && summary.count > 0 && (
                <MetaRow label="Rating" value={`${summary.avg.toFixed(1)} / 5`} />
              )}
              {createdByLabel && <MetaRow label="Created by" value={createdByLabel} />}
              {app.category && <MetaRow label="Category" value={app.category} />}
              {app.runtime && (
                <MetaRow
                  label="Runtime"
                  value={
                    <span style={{ fontFamily: 'JetBrains Mono, monospace', color: 'var(--ink)' }}>
                      {app.runtime}
                    </span>
                  }
                />
              )}
              <div style={{ height: 1, background: 'var(--line)', margin: '6px 0' }} />
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.07em',
                }}
              >
                For developers
              </div>
              <MetaRow
                label="License"
                value={app.manifest?.license?.trim() || 'See project documentation'}
              />
              {githubRepo && (
                <MetaRow
                  label="Source"
                  value={
                    <a
                      href={githubRepo}
                      target="_blank"
                      rel="noreferrer"
                      style={{
                        color: 'var(--accent)',
                        textDecoration: 'none',
                        fontWeight: 500,
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4,
                      }}
                    >
                      <GithubIcon /> GitHub
                    </a>
                  }
                />
              )}
            </aside>
          </div>
          {/* v6-align 2026-04-20: collapse affordance when the hero is
              expanded during a run. Puts the control in the same visual
              lane the user just clicked to expand from. */}
          {topBarCompact && heroExpanded && (
            <div style={{ marginTop: 18, textAlign: 'right' }}>
              <button
                type="button"
                onClick={() => setHeroExpanded(false)}
                data-testid="permalink-hero-collapse"
                style={{
                  padding: '7px 12px',
                  border: '1px solid var(--line)',
                  background: 'var(--card)',
                  color: 'var(--muted)',
                  borderRadius: 8,
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                Hide details
              </button>
            </div>
          )}
        </section>
        )}

        {/* v16 tab bar: Run is default, everything else is opt-in. This
            replaces the previous "scroll past marketing to reach the run
            surface" layout. Shared-run URLs (?run=<id>) land here already. */}
        <div
          role="tablist"
          aria-label="App content"
          data-testid="permalink-tabs"
          style={{
            display: 'flex',
            gap: 2,
            borderBottom: '1px solid var(--line)',
            marginBottom: 24,
            overflowX: 'auto',
          }}
        >
          {(
            [
              { id: 'run', label: 'Run' },
              { id: 'about', label: 'About' },
              { id: 'install', label: 'Install' },
              { id: 'source', label: 'Source' },
            ] as Array<{ id: PTab; label: string }>
          ).map((t) => {
            const isOn = activeTab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={isOn}
                data-testid={`permalink-tab-${t.id}`}
                data-state={isOn ? 'active' : 'inactive'}
                onClick={() => {
                  setActiveTab(t.id);
                  setSearchParams((prev) => {
                    const next = new URLSearchParams(prev);
                    if (t.id === 'run') next.delete('tab');
                    else next.set('tab', t.id);
                    return next;
                  }, { replace: true });
                }}
                style={{
                  padding: '10px 16px',
                  fontSize: 13,
                  fontWeight: 600,
                  border: 'none',
                  background: 'transparent',
                  color: isOn ? 'var(--accent)' : 'var(--muted)',
                  borderBottom: isOn ? '2px solid var(--accent)' : '2px solid transparent',
                  marginBottom: -1,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  whiteSpace: 'nowrap',
                }}
              >
                {t.label}
              </button>
            );
          })}
        </div>

        {/* Run tab (DEFAULT). CLS fix (2026-04-18): min-height so the
            output card's empty state → streaming → done transitions do
            not push footer content around above the fold. */}
        {activeTab === 'run' && (
          <section
            id="run"
            data-testid="tab-content-run-primary"
            data-surface="run"
            className="run-surface"
            style={{
              background: 'var(--card)',
              border: '1px solid var(--line)',
              borderRadius: 14,
              padding: '28px 24px',
              marginBottom: 32,
              minHeight: 320,
            }}
          >
            {initialRunLoading ? (
              <div
                data-testid="shared-run-loading"
                style={{ color: 'var(--muted)', fontSize: 13, padding: 24, textAlign: 'center' }}
              >
                Loading shared run...
              </div>
            ) : (
              <>
                {/* 2026-04-20 (P2 #147): gentle amber "Run not found" card
                    when /p/:slug?run=<bad-id> hits a 404. Amber, not red —
                    matches the new error-taxonomy cards from PR #167 for
                    recoverable / expected states. Renders above the empty
                    form so the user gets a fresh starting point without
                    having to edit the URL. */}
                {runNotFound && (
                  <div
                    data-testid="shared-run-not-found"
                    role="status"
                    style={{
                      background: 'rgba(245, 158, 11, 0.08)',
                      border: '1px solid rgba(245, 158, 11, 0.35)',
                      borderRadius: 12,
                      padding: '16px 20px',
                      marginBottom: 20,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 16,
                      flexWrap: 'wrap',
                    }}
                  >
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>
                        This run isn't available
                      </div>
                      <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
                        The link may have expired or the run was deleted. You
                        can still run {app.name} with fresh inputs below.
                      </div>
                    </div>
                    <button
                      type="button"
                      data-testid="shared-run-not-found-reset"
                      onClick={handleResetInitialRun}
                      style={{
                        padding: '8px 14px',
                        background: 'var(--card)',
                        border: '1px solid var(--line)',
                        borderRadius: 8,
                        fontSize: 13,
                        fontWeight: 500,
                        color: 'var(--ink)',
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                        textDecoration: 'none',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      Try this app →
                    </button>
                  </div>
                )}
                <RunSurface
                  app={app}
                  initialRun={initialRun}
                  onResetInitialRun={handleResetInitialRun}
                />
              </>
            )}
          </section>
        )}

        {/* About tab */}
        {activeTab === 'about' && (
        <>
        {/* How it works strip */}
        {howItWorks.length > 0 && (
          <section
            data-testid="how-it-works"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
              gap: 16,
              marginBottom: 40,
            }}
          >
            {howItWorks.map((step, idx) => (
              <div
                key={idx}
                style={{
                  background: 'var(--card)',
                  border: '1px solid var(--line)',
                  borderRadius: 14,
                  padding: 20,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 12,
                  minHeight: 180,
                }}
              >
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    color: 'var(--muted)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.07em',
                  }}
                >
                  How it works · {idx + 1} of {howItWorks.length}
                </div>
                <div
                  style={{
                    background: 'var(--bg)',
                    border: '1px solid var(--line)',
                    borderRadius: 10,
                    padding: 16,
                    flex: 1,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>
                    {step.label}
                  </div>
                  {step.description && (
                    <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.55 }}>
                      {step.description}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </section>
        )}

        {/* About + reviews. Round 2 polish: description already prints in
            the hero; duplicating it here created 2-3 repetitions on the
            same page (finding from UI audit v2). For short descriptions
            (< 200 chars) we skip the heading + paragraph entirely so the
            About tab becomes a pure ratings + reviews surface. Long
            descriptions (user-authored copy, > 200 chars) still render
            here as a secondary read. */}
        <section
          style={{
            background: 'var(--card)',
            border: '1px solid var(--line)',
            borderRadius: 14,
            padding: '32px 28px',
            marginBottom: 24,
          }}
        >
          {app.description && app.description.length >= 200 && (
            <>
              <h2
                style={{
                  fontSize: 18,
                  fontWeight: 600,
                  margin: '0 0 14px',
                  color: 'var(--ink)',
                  letterSpacing: '-0.01em',
                }}
              >
                About this app
              </h2>
              {/* Upgrade 3 (2026-04-19): markdown-enabled About copy. */}
              <DescriptionMarkdown
                description={app.description}
                testId="about-description"
                style={{
                  fontSize: 14,
                  color: 'var(--text-2, var(--muted))',
                  margin: 0,
                  lineHeight: 1.65,
                  marginBottom: 24,
                }}
              />
            </>
          )}

          {summary && summary.count > 0 && <RatingsWidget summary={summary} />}

          <AppReviews slug={app.slug} />
        </section>
        </>
        )}

        {/* Install tab. Round 2 polish: only Claude is live on day one.
            Previously we rendered a 4-card grid with 3 "COMING SOON"
            tiles (ChatGPT, Notion, Terminal), which made the page feel
            amateur. Keep one full card for Claude; below it, a single
            thin waitlist link consolidates the upcoming connectors so
            the live option does not compete with dead weight. */}
        {activeTab === 'install' && (
        <section id="connectors" data-testid="connectors" style={{ marginBottom: 32 }}>
          <h2
            style={{
              fontSize: 18,
              fontWeight: 600,
              margin: '0 0 14px',
              color: 'var(--ink)',
              letterSpacing: '-0.01em',
            }}
          >
            Add to your tools
          </h2>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1fr)',
              gap: 16,
              maxWidth: 560,
            }}
            data-testid="connectors-grid"
          >
            <ConnectorCard
              label="Claude"
              title="Add to Claude Desktop"
              desc="Use this app as a tool in Claude."
              testId="connector-claude"
              href="https://docs.anthropic.com/en/docs/claude-desktop"
              badge="MCP"
              copyValue={mcpEndpoint}
            />
          </div>
          <p
            data-testid="connectors-more"
            style={{
              marginTop: 14,
              fontSize: 13,
              color: 'var(--muted)',
              lineHeight: 1.55,
            }}
          >
            More clients (ChatGPT, Notion, Terminal) coming.{' '}
            <a
              href="/#waitlist"
              data-testid="connectors-waitlist"
              style={{ color: 'var(--accent)', fontWeight: 500, textDecoration: 'none' }}
            >
              Join the waitlist &rarr;
            </a>
          </p>
        </section>
        )}

        {/* Source tab: OpenAPI + manifest viewer (v1.1 stub). */}
        {activeTab === 'source' && (
          <section
            data-testid="tab-content-source"
            style={{
              background: 'var(--card)',
              border: '1px dashed var(--line)',
              borderRadius: 14,
              padding: '32px 28px',
              textAlign: 'center',
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
              Coming soon
            </div>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--ink)', margin: '0 0 6px' }}>
              Inspect the source
            </h2>
            <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 auto', maxWidth: 520, lineHeight: 1.55 }}>
              Browsable OpenAPI spec + floom manifest. Until this ships,
              grab the spec from <code style={{ fontFamily: 'JetBrains Mono, monospace' }}>/api/hub/{app.slug}/openapi.json</code>.
            </p>
          </section>
        )}
      </main>
      <Footer />
      <FeedbackButton />

      {comingSoon && (
        <ComingSoonModal
          target={comingSoon}
          mcpUrl={mcpEndpoint}
          curlExample={curlExample}
          cliExample={cliExample}
          onClose={() => setComingSoon(null)}
        />
      )}

      {shareToast && (
        <div
          role="status"
          data-testid="share-toast"
          style={{
            position: 'fixed',
            bottom: 24,
            left: '50%',
            transform: 'translateX(-50%)',
            padding: '10px 18px',
            borderRadius: 999,
            background: 'var(--ink)',
            color: '#fff',
            fontSize: 13,
            fontWeight: 500,
            boxShadow: '0 10px 30px rgba(0,0,0,0.2)',
            zIndex: 1100,
          }}
        >
          Link copied
        </div>
      )}
    </div>
  );
}

/* ----------------- small components ----------------- */

function formatRelativeTime(iso: string): string | null {
  try {
    const d = new Date(iso);
    const t = d.getTime();
    if (Number.isNaN(t)) return null;
    // Clamp negative diffs (future timestamps / clock skew) to 0 so we
    // never render `-Nm ago`. See lib/time.ts for the same guard.
    const diff = Math.max(0, Date.now() - t);
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months}mo ago`;
    const years = Math.floor(days / 365);
    return `${years}y ago`;
  } catch {
    return null;
  }
}

function Chevron() {
  return (
    <svg width={10} height={10} viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ArrowRight() {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M5 12h14M13 5l7 7-7 7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronDown() {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx={18} cy={5} r={3} stroke="currentColor" strokeWidth="1.8" />
      <circle cx={6} cy={12} r={3} stroke="currentColor" strokeWidth="1.8" />
      <circle cx={18} cy={19} r={3} stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M8.59 13.51l6.83 3.98M15.41 6.51l-6.82 3.98"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function GithubIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <use href="#icon-github" />
    </svg>
  );
}

function StarsRow({ value, size = 14 }: { value: number; size?: number }) {
  return (
    <div style={{ display: 'inline-flex', gap: 1, color: '#f2b100' }}>
      {[1, 2, 3, 4, 5].map((n) => (
        <svg
          key={n}
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill={n <= Math.round(value) ? 'currentColor' : 'none'}
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path
            d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14l-5-4.87 6.91-1.01L12 2z"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ))}
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <span style={{ color: 'var(--muted)' }}>{label}</span>
      <span style={{ color: 'var(--ink)', fontWeight: 500 }}>{value}</span>
    </div>
  );
}

function RatingsWidget({ summary }: { summary: ReviewSummary }) {
  return (
    <div
      data-testid="ratings-widget"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 24,
        marginBottom: 28,
        paddingBottom: 24,
        borderBottom: '1px solid var(--line)',
      }}
    >
      <div>
        <div
          style={{
            fontSize: 52,
            fontWeight: 700,
            lineHeight: 1,
            color: 'var(--ink)',
            letterSpacing: '-0.02em',
          }}
        >
          {summary.avg.toFixed(1)}
        </div>
        <div style={{ marginTop: 8 }}>
          <StarsRow value={summary.avg} size={16} />
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
          {summary.count} rating{summary.count === 1 ? '' : 's'}
        </div>
      </div>
    </div>
  );
}

function ConnectorCard({
  label,
  title,
  desc,
  testId,
  href,
  onClick,
  badge,
  copyValue,
  comingSoon,
}: {
  label: string;
  title: string;
  desc: string;
  testId: string;
  href?: string;
  onClick?: () => void;
  badge?: React.ReactNode;
  copyValue?: string;
  comingSoon?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    if (!copyValue) return;
    try {
      void navigator.clipboard.writeText(copyValue).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      });
    } catch {
      /* ignore */
    }
  };
  const commonStyle: React.CSSProperties = {
    background: 'var(--card)',
    border: '1px solid var(--line)',
    borderRadius: 14,
    padding: '18px 20px',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    color: 'var(--ink)',
    textDecoration: 'none',
    textAlign: 'left',
    cursor: href || onClick ? 'pointer' : 'default',
    fontFamily: 'inherit',
    minHeight: 140,
  };
  const inner = (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: 'var(--muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.07em',
          }}
        >
          {label}
        </span>
        {(badge || comingSoon) && (
          <span
            style={{
              padding: '3px 8px',
              borderRadius: 999,
              background: 'var(--accent-soft)',
              color: 'var(--accent)',
              fontSize: 10,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
            }}
          >
            {comingSoon ? 'Coming soon' : badge}
          </span>
        )}
      </div>
      <div style={{ fontSize: 15, fontWeight: 600 }}>{title}</div>
      <div style={{ fontSize: 13, color: 'var(--muted)', flex: 1 }}>{desc}</div>
      {copyValue && (
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            copy();
          }}
          style={{
            fontSize: 11,
            fontWeight: 600,
            padding: '6px 10px',
            border: '1px solid var(--line)',
            background: 'var(--bg)',
            borderRadius: 6,
            cursor: 'pointer',
            alignSelf: 'flex-start',
            color: copied ? 'var(--accent)' : 'var(--muted)',
            fontFamily: 'inherit',
          }}
        >
          {copied ? 'Copied' : 'Copy MCP URL'}
        </button>
      )}
    </>
  );
  if (href) {
    return (
      <a
        data-testid={testId}
        href={href}
        target="_blank"
        rel="noreferrer"
        style={commonStyle}
      >
        {inner}
      </a>
    );
  }
  if (onClick) {
    return (
      <button
        type="button"
        data-testid={testId}
        onClick={onClick}
        style={commonStyle}
      >
        {inner}
      </button>
    );
  }
  return (
    <div data-testid={testId} style={commonStyle}>
      {inner}
    </div>
  );
}

function ComingSoonModal({
  target,
  mcpUrl,
  curlExample,
  cliExample,
  onClose,
}: {
  target: ComingSoonTarget;
  mcpUrl: string;
  curlExample: string;
  cliExample: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const config = (() => {
    switch (target) {
      case 'chatgpt':
        return {
          title: 'Add to ChatGPT',
          copy:
            'One-click install is coming soon. For now, copy the MCP URL and paste it into your ChatGPT custom GPT under "Actions".',
          value: mcpUrl,
          valueLabel: 'MCP URL',
        };
      case 'notion':
        return {
          title: 'Add to Notion',
          copy:
            'One-click install is coming soon. For now, copy the MCP URL and paste it into the Floom connector block on your Notion page.',
          value: mcpUrl,
          valueLabel: 'MCP URL',
        };
      case 'terminal':
        return {
          title: 'Add to Terminal',
          copy: 'The floom CLI ships alongside Cloud tier. For now, run from any shell with curl.',
          value: `${cliExample}\n\n# or HTTP:\n${curlExample}`,
          valueLabel: 'Command',
        };
      case 'schedule':
      default:
        return {
          title: 'Scheduling is coming soon',
          copy: 'Scheduled runs ship with the job queue release.',
          value: mcpUrl,
          valueLabel: 'MCP URL',
        };
    }
  })();

  const copy = () => {
    try {
      void navigator.clipboard.writeText(config.value).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      });
    } catch {
      /* ignore */
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="coming-soon-title"
      data-testid={`coming-soon-modal-${target}`}
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(14, 14, 12, 0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--card)',
          border: '1px solid var(--line)',
          borderRadius: 14,
          padding: '28px 28px 24px',
          maxWidth: 500,
          width: '100%',
          boxShadow: '0 20px 60px rgba(0,0,0,0.15)',
        }}
      >
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 10px',
            borderRadius: 999,
            background: 'var(--accent-soft)',
            color: 'var(--accent)',
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            marginBottom: 14,
          }}
        >
          Coming soon
        </div>
        <h2
          id="coming-soon-title"
          style={{ fontSize: 20, fontWeight: 700, margin: '0 0 10px', color: 'var(--ink)' }}
        >
          {config.title}
        </h2>
        <p style={{ fontSize: 14, color: 'var(--muted)', margin: '0 0 20px', lineHeight: 1.55 }}>
          {config.copy}
        </p>
        <div
          style={{
            background: 'var(--bg)',
            border: '1px solid var(--line)',
            borderRadius: 8,
            padding: '10px 12px',
            display: 'flex',
            alignItems: 'flex-start',
            gap: 10,
            marginBottom: 18,
          }}
        >
          <pre
            style={{
              flex: 1,
              margin: 0,
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 12,
              color: 'var(--ink)',
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              maxHeight: 140,
            }}
          >
            {config.value}
          </pre>
          <button
            type="button"
            onClick={copy}
            data-testid="coming-soon-copy"
            style={{
              padding: '6px 12px',
              background: 'var(--accent)',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
              flexShrink: 0,
            }}
          >
            {copied ? 'Copied' : `Copy ${config.valueLabel}`}
          </button>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: '8px 18px',
              background: 'transparent',
              color: 'var(--muted)',
              border: '1px solid var(--line)',
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 500,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
