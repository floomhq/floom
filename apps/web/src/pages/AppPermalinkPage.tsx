// /p/:slug — product page (user view). v17 redesign 2026-04-23 to match
// wireframes.floom.dev/v17/app-page.html:
//   - Outer 18px frame card (quiet shadow, overflow hidden) wraps the
//     whole page.
//   - Compact .app-header INSIDE the frame: 40px flat tile + 17px title +
//     13px muted description sub + right-aligned CTA cluster (version
//     tag, Schedule, Share). No more radial-gradient tile + shadow ring.
//   - RunSurface renders inside the frame body (unchanged — owns its own
//     split-layout and empty/running/done states).
//   - About / Install / Source content swaps inside the frame body based
//     on ?tab=.
//   - Mid-page underlined tab bar REMOVED. Replaced with a quiet chip
//     row at the bottom of the frame (About / Install / Source / Source).
//     Active chip uses --accent-soft bg, non-active is plain pill.
//   - Breadcrumb row above the frame is small + quiet (Store / name).
//
// Schedule drawer and ChatGPT/Notion/Terminal connectors stay as explicit
// "coming soon" stubs (schedule needs job queue UI; the provider
// connectors ship after v1 per project_floom_layers.md).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { TopBar } from '../components/TopBar';
import { Footer } from '../components/Footer';
import { RunSurface, type RunSurfaceResult } from '../components/runner/RunSurface';
import { AppIcon } from '../components/AppIcon';
import { AppReviews } from '../components/AppReviews';
import { FeedbackButton } from '../components/FeedbackButton';
import { DescriptionMarkdown } from '../components/DescriptionMarkdown';
import { Confetti } from '../components/Confetti';
import { getApp, getAppReviews, getRun, shareRun, ApiError } from '../api/client';
import { useSession } from '../hooks/useSession';
import type { ActionSpec, AppDetail, ReviewSummary, RunRecord } from '../lib/types';
import {
  buildPublicRunPath,
  classifyPermalinkLoadError,
  getPermalinkLoadErrorMessage,
  type PermalinkLoadOutcome,
} from '../lib/publicPermalinks';
import {
  consumeJustPublished,
  hasConfettiShown,
  markConfettiShown,
  samplePrefill,
} from '../lib/onboarding';

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

  // 2026-04-21 restructure: the hero is now ALWAYS compact. The old
  // full-fold hero pushed the Run form below the fold on 1279x712, which
  // was Federico's complaint (screenshot 21.11.45). Meta (Category /
  // License / Runtime / Created by) moved to the About tab's Details
  // block so the Run form is the first interactive surface on /p/:slug.
  // The previous `heroExpanded` toggle + dual-state rendering is gone.

  // First-run onboarding glue:
  //   - fire confetti + share card on the first successful run the user
  //     sees for an app they haven't celebrated yet (keyed in localStorage)
  //   - show a muted "Your app is live" card with Copy-link + Make-another
  //     once confetti has played
  const [confettiFire, setConfettiFire] = useState(false);
  const [celebrate, setCelebrate] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  // Issue #255 (2026-04-21): run completion and publish celebration are
  // two different moments. The "Your app is live — send to coworkers"
  // card only fires on PUBLISH (consumed via localStorage). Successful
  // runs get a quieter "Run complete · Share this run" row instead.
  const [runCompleteRunId, setRunCompleteRunId] = useState<string | null>(null);
  const [runShareCopied, setRunShareCopied] = useState(false);

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

  // 2026-04-21 restructure: after the Run surface mounts (not a shared
  // run, Run tab active), move keyboard focus to the first visible input
  // so power users can type + submit without a click. Scoped to the
  // RunSurface container so we don't steal focus from e.g. a toast. We
  // scope the effect to the (slug, activeTab) pair so switching tabs
  // away and back doesn't re-steal focus mid-scroll.
  const runSurfaceRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (activeTab !== 'run') return;
    if (runIdFromUrl || initialRun || initialRunLoading) return;
    if (!app) return;
    // Defer one frame so RunSurface and InputCard have mounted.
    const raf = requestAnimationFrame(() => {
      const root = runSurfaceRef.current;
      if (!root) return;
      const target = root.querySelector<HTMLElement>(
        'input.input-field, textarea.input-field, select.input-field',
      );
      if (target && typeof target.focus === 'function') {
        // preventScroll so auto-focus doesn't trigger a jump on long pages.
        target.focus({ preventScroll: true });
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [app, activeTab, runIdFromUrl, initialRun, initialRunLoading]);

  // Single-line plain-text description for the compact header. Strips
  // markdown syntax + collapses whitespace so a multi-line or markdown
  // description still renders as one clean line above the tabs. The full
  // rich description still renders (markdown-formatted) in the About tab.
  const headerDescription = useMemo<string>(() => {
    if (!app?.description) return '';
    return app.description
      // drop fenced code blocks entirely
      .replace(/```[\s\S]*?```/g, ' ')
      // inline code -> bare
      .replace(/`([^`]+)`/g, '$1')
      // links -> label only
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      // emphasis / strong markers
      .replace(/(\*\*|__|\*|_)/g, '')
      // headings / list markers at line start
      .replace(/^\s*(#+|[-*+]|\d+\.)\s+/gm, '')
      // collapse whitespace
      .replace(/\s+/g, ' ')
      .trim();
  }, [app?.description]);

  // Compute sample input pre-fill for the first input of each action.
  // Only fires on first visit (no shared-run ?run=<id>) so that a direct
  // link to a completed run stays faithful to the inputs that actually
  // produced it. We hydrate ALL inputs (so RunSurface's buildInitialInputs
  // doesn't discard our value in favour of '' for the unprefilled ones),
  // but only assign real samples to inputs whose name/type we recognise.
  const samplePrefillInputs = useMemo<Record<string, unknown> | null>(() => {
    if (!app) return null;
    if (runIdFromUrl) return null; // respect shared-run links
    const firstActionKey = Object.keys(app.manifest.actions)[0];
    const action = firstActionKey ? app.manifest.actions[firstActionKey] : undefined;
    if (!action || action.inputs.length === 0) return null;
    // Prefill ONLY the first input (the one the user would have clicked
    // into first). Everything else uses its existing default/empty.
    const first = action.inputs[0];
    const sample = samplePrefill(first);
    if (sample == null) return null;
    return { [first.name]: sample };
  }, [app, runIdFromUrl]);

  // Issue #255 (2026-04-21): the celebration card ("Your app is live —
  // send to coworkers") must only fire for the creator who JUST pressed
  // Publish, not for every visitor who runs the app. BuildPage writes a
  // slug-scoped flag on publish success; we consume it here on mount.
  // Successful runs hit `handleRunResult` and get a quieter inline
  // "Run complete · Share this run" row anchored near the output.
  useEffect(() => {
    if (!app?.slug) return;
    if (!consumeJustPublished(app.slug)) return;
    if (!hasConfettiShown(app.slug)) {
      markConfettiShown(app.slug);
      setConfettiFire(true);
    }
    setCelebrate(true);
  }, [app?.slug]);

  const handleRunResult = useCallback(
    (result: RunSurfaceResult) => {
      if (!app) return;
      if (result.exitCode !== 0) return;
      // Surface the lightweight run-complete acknowledgement. The publish
      // celebration is handled separately (see effect above).
      setRunCompleteRunId(result.runId);
      setRunShareCopied(false);
    },
    [app],
  );

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
      url: `${window.location.origin}/p/${app.slug}`,
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
    // CLS fix (carried over from 2026-04-18, v17 refactor 2026-04-23):
    // the skeleton mirrors the v17 frame layout above-the-fold so that
    // loading → loaded produces near-zero CLS. Frame · compact header
    // row · content body placeholder · chip row.
    return (
      <div className="page-root">
        <TopBar />
        <main
          style={{ padding: '20px 24px 80px', maxWidth: 1200, margin: '0 auto' }}
          data-testid="permalink-page"
          aria-busy="true"
        >
          {/* Breadcrumb placeholder */}
          <div style={{ height: 18, marginBottom: 14, width: 180, background: 'var(--line)', opacity: 0.25, borderRadius: 4 }} />

          {/* Frame card */}
          <div
            style={{
              background: 'var(--card)',
              border: '1px solid var(--line)',
              borderRadius: 18,
              overflow: 'hidden',
              boxShadow: '0 1px 3px rgba(22,21,18,.04), 0 4px 20px rgba(22,21,18,.06)',
            }}
          >
            {/* Compact app-header */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                padding: '18px 24px 16px',
                borderBottom: '1px solid var(--line)',
              }}
            >
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 11,
                  background: 'var(--bg)',
                  border: '1px solid var(--line)',
                  flexShrink: 0,
                }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ height: 18, width: '40%', borderRadius: 4, background: 'var(--line)', opacity: 0.35, marginBottom: 6 }} />
                <div style={{ height: 12, width: '70%', borderRadius: 4, background: 'var(--line)', opacity: 0.22 }} />
              </div>
              <div style={{ height: 32, width: 120, borderRadius: 8, background: 'var(--line)', opacity: 0.2 }} />
            </div>

            {/* Body */}
            <div style={{ padding: '24px', minHeight: 360, background: 'var(--card)' }}>
              <p style={{ color: 'var(--muted)', fontSize: 13, textAlign: 'center', padding: 24 }}>
                Loading...
              </p>
            </div>

            {/* Chip row */}
            <div
              style={{
                display: 'flex',
                gap: 10,
                padding: '14px 24px',
                borderTop: '1px solid var(--line)',
                background: 'var(--card)',
              }}
            >
              {[1, 2, 3].map((i) => (
                <div
                  key={i}
                  style={{ height: 28, width: 110, borderRadius: 999, background: 'var(--line)', opacity: 0.22 }}
                />
              ))}
            </div>
          </div>
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

  // Use the live origin so each env (floom.dev, preview.floom.dev,
  // docker.floom.dev) exposes its own endpoints in the share/MCP panels.
  const mcpEndpoint = `${window.location.origin}/mcp/app/${app.slug}`;
  const githubRepo = GITHUB_REPOS[app.slug];

  // Upgrade 4 (2026-04-19): compact TopBar when a run is active so the
  // output gets more vertical room. True whenever ?run=<id> is present
  // (shared-run hydration path) OR we have a resolved initialRun in
  // state. Single-source-of-truth read so the flag flips back to false
  // as soon as the user clears the shared-run banner.
  const topBarCompact = Boolean(runIdFromUrl || initialRun);

  return (
    <div className="page-root">
      <TopBar compact={topBarCompact} />

      <Confetti fire={confettiFire} onDone={() => setConfettiFire(false)} />

      <main
        id="main"
        style={{ padding: '24px 24px 80px', maxWidth: 1200, margin: '0 auto' }}
        data-testid="permalink-page"
      >
        {/* v17 breadcrumb: quiet Store / app-name. Lives OUTSIDE the
            frame, small + muted. "Open in Studio" affordance (owner only)
            sits on the right. */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
            marginBottom: 14,
            fontSize: 13,
            color: 'var(--muted)',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
            }}
          >
            <Link to="/apps" style={{ color: 'var(--muted)', textDecoration: 'none' }}>
              Store
            </Link>
            <span aria-hidden="true" style={{ color: 'var(--line)' }}>/</span>
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

        {/* v17 frame: 18px-radius white card wrapping the whole app page
            (compact app-header · content body · chip row). Shadow is
            quiet so the frame reads as a chip, not a popover. */}
        <div
          className="app-page-frame"
          style={{
            background: 'var(--card)',
            border: '1px solid var(--line)',
            borderRadius: 18,
            overflow: 'hidden',
            boxShadow: '0 1px 3px rgba(22,21,18,.04), 0 4px 20px rgba(22,21,18,.06)',
          }}
        >
          {/* v17 compact app-header: 40px flat tile + 17px title + 13px
              muted description + right-aligned CTA cluster (version
              meta, Schedule, Share). Replaces the prior 2026-04-21
              radial-gradient hero. Test-ids preserved so analytics +
              smoke stay green. */}
          <section
            data-testid="permalink-hero"
            className="permalink-hero-row"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              padding: '18px 24px 16px',
              borderBottom: '1px solid var(--line)',
              flexWrap: 'wrap',
            }}
          >
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: 11,
                background: 'var(--bg)',
                border: '1px solid var(--line)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--accent)',
                flexShrink: 0,
              }}
            >
              <AppIcon slug={app.slug} size={22} />
            </div>
            <div className="permalink-hero-title" style={{ flex: 1, minWidth: 0 }}>
              <h1
                style={{
                  fontSize: 17,
                  fontWeight: 700,
                  color: 'var(--ink)',
                  margin: 0,
                  lineHeight: 1.25,
                  letterSpacing: '-0.01em',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {app.name}
              </h1>
              {headerDescription && (
                <p
                  data-testid="hero-description"
                  title={headerDescription}
                  style={{
                    fontSize: 13,
                    color: 'var(--muted)',
                    margin: '2px 0 0',
                    lineHeight: 1.5,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    maxWidth: '100%',
                  }}
                >
                  {headerDescription}
                </p>
              )}
            </div>
            <div
              className="permalink-hero-actions"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                flexShrink: 0,
                flexWrap: 'wrap',
              }}
            >
              <span
                data-testid="hero-version-meta"
                className="permalink-hero-version-meta"
                style={{
                  fontSize: 10.5,
                  color: 'var(--muted)',
                  fontFamily: 'JetBrains Mono, ui-monospace, monospace',
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  flexWrap: 'wrap',
                }}
              >
                <span data-testid="hero-version">v{app.version ?? '0.1.0'}</span>
                <span aria-hidden="true">·</span>
                <span data-testid="hero-version-status">{app.version_status ?? 'stable'}</span>
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
                {summary && summary.count > 0 && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, textTransform: 'none', letterSpacing: 0 }}>
                      <StarsRow value={summary.avg} size={12} />
                      {summary.avg.toFixed(1)} ({summary.count})
                    </span>
                  </>
                )}
              </span>
              {app.author && sessionUserId && app.author === sessionUserId && (
                <Link
                  to={`/studio/${app.slug}/triggers`}
                  data-testid="cta-schedule"
                  style={{
                    padding: '8px 12px',
                    border: '1px solid var(--line)',
                    borderRadius: 10,
                    fontSize: 12.5,
                    fontWeight: 600,
                    color: 'var(--ink)',
                    background: 'var(--card)',
                    textDecoration: 'none',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    whiteSpace: 'nowrap',
                  }}
                >
                  Schedule
                </Link>
              )}
              <button
                type="button"
                data-testid="cta-share"
                aria-label="Share link"
                onClick={() => {
                  // Same share logic as before: if ?run=<id> is in the URL,
                  // opt the run public via shareRun() and copy the /r/:id
                  // permalink; otherwise copy the bare app page URL. Keeps
                  // anon-viewer share-link flow intact.
                  const copyUrl = (url: string) => {
                    void navigator.clipboard.writeText(url).then(() => {
                      setShareToast(true);
                      window.setTimeout(() => setShareToast(false), 1800);
                    });
                  };
                  try {
                    const currentUrl = new URL(window.location.href);
                    const currentRunId = currentUrl.searchParams.get('run');
                    if (!currentRunId) {
                      copyUrl(currentUrl.toString());
                      return;
                    }
                    void shareRun(currentRunId)
                      .then(() => {
                        copyUrl(
                          `${window.location.origin}${buildPublicRunPath(currentRunId)}`,
                        );
                      })
                      .catch(() => {
                        currentUrl.searchParams.delete('run');
                        copyUrl(currentUrl.toString());
                      });
                  } catch {
                    /* ignore */
                  }
                }}
                style={{
                  padding: '8px 12px',
                  border: '1px solid var(--line)',
                  borderRadius: 10,
                  fontSize: 12.5,
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
                <ShareIcon /> Share
              </button>
            </div>
          </section>

          {/* Frame body: swappable by ?tab= (Run / About / Install / Source).
              v17 removes the mid-page underlined tab bar — secondary
              surfaces live behind chips in the footer row below. Test-id
              permalink-tabs moved to that chip row so analytics stay green. */}
          <div
            className="app-page-body"
            style={{
              padding: '24px',
              background: 'var(--card)',
            }}
          >

        {/* Run tab (DEFAULT). Renders inside the frame body, so no own
            border/radius. CLS fix (2026-04-18): min-height so the
            output card's empty state → streaming → done transitions do
            not push footer content around above the fold. */}
        {activeTab === 'run' && (
          <section
            id="run"
            ref={runSurfaceRef}
            data-testid="tab-content-run-primary"
            data-surface="run"
            className="run-surface"
            style={{
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
                  initialInputs={samplePrefillInputs ?? undefined}
                  onResetInitialRun={handleResetInitialRun}
                  onResult={handleRunResult}
                />
                {celebrate && (
                  <CelebrationCard
                    slug={app.slug}
                    copied={shareCopied}
                    onCopy={() => {
                      try {
                        navigator.clipboard.writeText(window.location.href);
                        setShareCopied(true);
                        window.setTimeout(() => setShareCopied(false), 1800);
                      } catch {
                        /* clipboard blocked — show toast fallback */
                      }
                    }}
                    onDismiss={() => setCelebrate(false)}
                  />
                )}
                {!celebrate && runCompleteRunId && (
                  <RunCompleteCard
                    runId={runCompleteRunId}
                    copied={runShareCopied}
                    onCopy={() => {
                      try {
                        const url = new URL(window.location.href);
                        url.pathname = buildPublicRunPath(runCompleteRunId);
                        url.search = '';
                        navigator.clipboard.writeText(url.toString());
                        setRunShareCopied(true);
                        window.setTimeout(() => setRunShareCopied(false), 1800);
                      } catch {
                        /* clipboard blocked */
                      }
                    }}
                    onDismiss={() => setRunCompleteRunId(null)}
                  />
                )}
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

        {/* About + reviews. v17 restructure: sits inside the frame body
            so no own border/radius. The hero still shows a one-line
            truncated description, so the full markdown description
            always renders here (no more 200-char gate). This is the
            canonical prose surface for the app. */}
        <section
          style={{
            paddingBottom: 24,
            marginBottom: 24,
            borderBottom: '1px solid var(--line)',
          }}
        >
          {app.description && (
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

        {/* Details block. v17: sits inside the frame body with a subtle
            surface-2 card to differentiate from the About prose above. */}
        <section
          data-testid="details-card"
          style={{
            background: 'var(--bg)',
            border: '1px solid var(--line)',
            borderRadius: 12,
            padding: '20px 22px',
          }}
        >
          <h2
            style={{
              fontSize: 14,
              fontWeight: 700,
              margin: '0 0 14px',
              color: 'var(--ink)',
              textTransform: 'uppercase',
              letterSpacing: '0.07em',
            }}
          >
            Details
          </h2>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: '10px 28px',
              fontSize: 13,
              color: 'var(--muted)',
            }}
          >
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
            {summary && summary.count > 0 && (
              <MetaRow label="Rating" value={`${summary.avg.toFixed(1)} / 5`} />
            )}
            <MetaRow
              label="License"
              value={
                githubRepo ? (
                  <a
                    href={`${githubRepo}/blob/main/LICENSE`}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      color: 'var(--accent)',
                      textDecoration: 'none',
                      fontWeight: 500,
                    }}
                  >
                    {app.manifest?.license?.trim() || 'View LICENSE'}
                  </a>
                ) : app.manifest?.license?.trim() ? (
                  app.manifest.license.trim()
                ) : (
                  'See project documentation'
                )
              }
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
          </div>
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
        <section id="connectors" data-testid="connectors">
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

        {/* Source tab: OpenAPI + manifest viewer (v1.1 stub). v17: dashed
            panel on --bg surface, rests inside the frame body. */}
        {activeTab === 'source' && (
          <section
            data-testid="tab-content-source"
            style={{
              background: 'var(--bg)',
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
          </div>
          {/* /frame body */}

          {/* v17 quiet chip row — secondary surfaces (Run / About /
              Install / Source) demoted from a mid-page underlined tab
              bar to a pill row at the bottom of the frame. Active chip
              reads as a green pill (--accent-soft bg + --accent-border
              + --accent text), non-active reads as a plain pill. */}
          <div
            role="tablist"
            aria-label="App content"
            data-testid="permalink-tabs"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '14px 24px',
              borderTop: '1px solid var(--line)',
              background: 'var(--card)',
              flexWrap: 'wrap',
            }}
          >
            {(
              [
                { id: 'run', label: 'Run' },
                { id: 'about', label: 'About this app' },
                { id: 'install', label: 'Install in Claude' },
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
                    padding: '7px 13px',
                    fontSize: 12.5,
                    fontWeight: isOn ? 600 : 500,
                    border: isOn
                      ? '1px solid var(--accent-border)'
                      : '1px solid var(--line)',
                    background: isOn ? 'var(--accent-soft)' : 'var(--card)',
                    color: isOn ? 'var(--accent)' : 'var(--muted)',
                    borderRadius: 999,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    whiteSpace: 'nowrap',
                    transition: 'color .12s, border-color .12s, background .12s',
                  }}
                >
                  {t.label}
                </button>
              );
            })}
          </div>
        </div>
        {/* /frame */}
      </main>
      <Footer />
      <FeedbackButton />

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

/**
 * CelebrationCard — rendered inline below the RunSurface once the user
 * completes their first successful run on an app. Keeps the post-run
 * moment anchored near the output they just produced rather than
 * hijacking the viewport with a modal. Copy-link + Make-another.
 */
function CelebrationCard({
  slug,
  copied,
  onCopy,
  onDismiss,
}: {
  slug: string;
  copied: boolean;
  onCopy: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      role="status"
      data-testid="celebration-card"
      style={{
        marginTop: 18,
        padding: '18px 20px',
        borderRadius: 14,
        border: '1px solid var(--accent, #10b981)',
        background: 'rgba(16, 185, 129, 0.06)',
        display: 'flex',
        flexWrap: 'wrap',
        gap: 12,
        alignItems: 'center',
        justifyContent: 'space-between',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <strong style={{ fontSize: 15, color: 'var(--ink, #0f172a)' }}>
          Your app is live
        </strong>
        <p style={{ margin: '4px 0 0', color: 'var(--muted, #64748b)', fontSize: 13 }}>
          This link works for anyone — send it to coworkers, Twitter, anywhere.
        </p>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          data-testid="celebration-copy"
          onClick={onCopy}
          style={{
            padding: '8px 14px',
            borderRadius: 8,
            background: 'var(--accent, #10b981)',
            color: '#fff',
            border: 'none',
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          {copied ? 'Copied!' : 'Copy share link'}
        </button>
        <Link
          to="/studio/build"
          data-testid="celebration-make-another"
          style={{
            padding: '8px 14px',
            borderRadius: 8,
            background: 'var(--card, #fff)',
            color: 'var(--ink, #0f172a)',
            border: '1px solid var(--line, #e5e7eb)',
            fontSize: 13,
            fontWeight: 500,
            textDecoration: 'none',
          }}
        >
          Make another
        </Link>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={`Dismiss celebration for ${slug}`}
          style={{
            padding: '8px 10px',
            borderRadius: 8,
            background: 'transparent',
            color: 'var(--muted, #64748b)',
            border: 'none',
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

/**
 * RunCompleteCard — quiet acknowledgement after a successful run. This is
 * intentionally lighter than CelebrationCard: no green accent wash, no
 * "send it to coworkers" copy (which only belongs to the first-publish
 * moment per Issue #255). Just "Run complete" + a Share-this-run link.
 */
function RunCompleteCard({
  runId,
  copied,
  onCopy,
  onDismiss,
}: {
  runId: string;
  copied: boolean;
  onCopy: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      role="status"
      data-testid="run-complete-card"
      style={{
        marginTop: 14,
        padding: '12px 16px',
        borderRadius: 10,
        border: '1px solid var(--line, #e5e7eb)',
        background: 'var(--card, #fff)',
        display: 'flex',
        flexWrap: 'wrap',
        gap: 10,
        alignItems: 'center',
        justifyContent: 'space-between',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <strong style={{ fontSize: 13, color: 'var(--ink, #0f172a)' }}>
          Run complete
        </strong>
        <span
          style={{
            marginLeft: 8,
            color: 'var(--muted, #64748b)',
            fontSize: 12,
          }}
        >
          Share this specific run with a link.
        </span>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button
          type="button"
          data-testid="run-complete-copy"
          onClick={onCopy}
          style={{
            padding: '6px 12px',
            borderRadius: 8,
            background: 'var(--card, #fff)',
            color: 'var(--ink, #0f172a)',
            border: '1px solid var(--line, #e5e7eb)',
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          {copied ? 'Copied!' : 'Share this run'}
        </button>
        <Link
          to={buildPublicRunPath(runId)}
          data-testid="run-complete-open"
          style={{
            padding: '6px 12px',
            borderRadius: 8,
            background: 'transparent',
            color: 'var(--muted, #64748b)',
            border: '1px solid transparent',
            fontSize: 12,
            fontWeight: 500,
            textDecoration: 'none',
          }}
        >
          Open
        </Link>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss run complete notice"
          style={{
            padding: '6px 8px',
            borderRadius: 8,
            background: 'transparent',
            color: 'var(--muted, #64748b)',
            border: 'none',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          ×
        </button>
      </div>
    </div>
  );
}
