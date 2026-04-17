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
import { FloomApp } from '../components/FloomApp';
import { AppIcon } from '../components/AppIcon';
import { AppReviews } from '../components/AppReviews';
import { FeedbackButton } from '../components/FeedbackButton';
import { getApp, getAppReviews, getRun } from '../api/client';
import type { ActionSpec, AppDetail, ReviewSummary, RunRecord } from '../lib/types';

// Map of known app slugs to GitHub repo URLs. Only slugs whose example
// directory lives in examples/ are linked; stub-only apps (floom.yaml with
// no server code) were removed in the 2026-04-17 bloat cut.
const GITHUB_REPOS: Record<string, string> = {
  flyfast: 'https://github.com/floomhq/floom-monorepo/tree/main/examples/flyfast',
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

  const [app, setApp] = useState<AppDetail | null>(null);
  const [summary, setSummary] = useState<ReviewSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [comingSoon, setComingSoon] = useState<ComingSoonTarget | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  // Run prefetched from /api/run/:id when the URL contains ?run=<id>. Lets
  // FloomApp hydrate directly into the `done` phase for shared links.
  const [initialRun, setInitialRun] = useState<RunRecord | null>(null);
  // initialRunLoading avoids rendering the FloomApp in `inputs` phase (which
  // would flash the empty form) while the run is being fetched.
  const [initialRunLoading, setInitialRunLoading] = useState<boolean>(!!runIdFromUrl);

  useEffect(() => {
    if (!slug) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    getApp(slug)
      .then((a) => {
        setApp(a);
        setLoading(false);
      })
      .catch(() => {
        setNotFound(true);
        setLoading(false);
      });
    // Fetch review summary separately so hero can show it without waiting
    // on AppReviews mounting.
    getAppReviews(slug, 1)
      .then((res) => setSummary(res.summary))
      .catch(() => setSummary({ count: 0, avg: 0 }));
  }, [slug]);

  // /p/:slug?run=<id> — fetch the run and hydrate FloomApp read-only.
  // Scoped to this slug so a run-id from a different app is silently
  // ignored (prevents accidentally mounting someone else's run into an
  // unrelated page). If the run is owned by a private (auth-required)
  // app that this visitor can't see, GET /api/run/:id returns 401 and we
  // just drop the initial-run state, showing the empty form instead.
  useEffect(() => {
    if (!slug || !runIdFromUrl) {
      setInitialRun(null);
      setInitialRunLoading(false);
      return;
    }
    let cancelled = false;
    setInitialRunLoading(true);
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
        // yet; the FloomApp stream/poll path owns that UI surface.
        if (['success', 'error', 'timeout'].includes(run.status)) {
          setInitialRun(run);
        } else {
          setInitialRun(null);
        }
      })
      .catch(() => {
        if (cancelled) return;
        setInitialRun(null);
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
    setMeta('og:url', `https://preview.floom.dev/p/${app.slug}`, true);
    setMeta('og:type', 'website', true);

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
      author: { '@type': 'Person', name: app.author || 'floomhq' },
    });
    document.head.appendChild(script);

    return () => {
      document.title = 'Floom: production layer for AI apps';
      const s = document.getElementById('jsonld-app');
      if (s) s.remove();
    };
  }, [app]);

  // First 3 manifest actions drive the "how it works" strip. Falls back
  // to the raw `actions` list (older-format apps) if manifest is empty.
  const howItWorks = useMemo<Array<{ label: string; description?: string }>>(() => {
    if (!app) return [];
    const entries = Object.entries(app.manifest?.actions ?? {}) as Array<[string, ActionSpec]>;
    if (entries.length > 0) {
      return entries.slice(0, 3).map(([, spec]) => ({
        label: spec.label,
        description: spec.description,
      }));
    }
    return (app.actions || []).slice(0, 3).map((name) => ({ label: name }));
  }, [app]);

  if (loading) {
    return (
      <div className="page-root">
        <TopBar />
        <main className="main" style={{ paddingTop: 80, textAlign: 'center' }}>
          <p style={{ color: 'var(--muted)', fontSize: 14 }}>Loading...</p>
        </main>
        <Footer />
      </div>
    );
  }

  if (notFound || !app) {
    return (
      <div className="page-root">
        <TopBar />
        <main className="main" style={{ paddingTop: 80, textAlign: 'center', maxWidth: 480, margin: '0 auto' }}>
          <h1 style={{ fontSize: 32, fontWeight: 700, margin: '0 0 12px' }}>404</h1>
          <p style={{ color: 'var(--muted)', fontSize: 16, margin: '0 0 32px' }}>
            No app found at <code style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 13 }}>/p/{slug}</code>
          </p>
          <Link
            to="/apps"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '10px 20px',
              background: 'var(--accent)',
              color: '#fff',
              borderRadius: 8,
              fontSize: 14,
              fontWeight: 600,
              textDecoration: 'none',
            }}
          >
            Back to all apps
          </Link>
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

  return (
    <div className="page-root">
      <TopBar />

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
          <Link
            to={`/creator/${app.slug}`}
            data-testid="open-creator-dashboard"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              color: 'var(--muted)',
              textDecoration: 'none',
              fontWeight: 500,
            }}
          >
            Open creator dashboard <ArrowRight />
          </Link>
        </div>

        {/* Hero */}
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
              <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 12 }}>
                {app.author && <span>by @{app.author}</span>}
                {app.author && app.category && <span> · </span>}
                {app.category && <span>{app.category}</span>}
              </div>

              {summary && summary.count > 0 && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    flexWrap: 'wrap',
                    marginBottom: 14,
                  }}
                >
                  <StarsRow value={summary.avg} size={16} />
                  <span style={{ fontSize: 13, color: 'var(--muted)' }}>
                    {summary.avg.toFixed(1)} · {summary.count} rating
                    {summary.count === 1 ? '' : 's'}
                  </span>
                </div>
              )}

              <p
                style={{
                  fontSize: 16,
                  color: 'var(--text-2, var(--ink))',
                  margin: '0 0 24px',
                  lineHeight: 1.55,
                  maxWidth: 620,
                }}
              >
                {app.description}
              </p>

              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <a
                  href="#run"
                  data-testid="cta-run"
                  style={{
                    padding: '11px 22px',
                    background: 'var(--accent)',
                    color: '#fff',
                    borderRadius: 10,
                    fontSize: 14,
                    fontWeight: 600,
                    textDecoration: 'none',
                  }}
                >
                  Run {app.name}
                </a>
                <a
                  href="#connectors"
                  data-testid="cta-add-to-tools"
                  style={{
                    padding: '11px 18px',
                    border: '1px solid var(--line)',
                    borderRadius: 10,
                    fontSize: 14,
                    fontWeight: 600,
                    color: 'var(--ink)',
                    background: 'var(--card)',
                    textDecoration: 'none',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  Add to your tools <ChevronDown />
                </a>
                <button
                  type="button"
                  data-testid="cta-schedule"
                  onClick={() => setScheduleOpen((v) => !v)}
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
                  <CalendarClock /> Schedule
                </button>
                <button
                  type="button"
                  data-testid="cta-share"
                  onClick={() => {
                    try {
                      void navigator.clipboard.writeText(window.location.href);
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

              {scheduleOpen && (
                <ScheduleDrawer onClose={() => setScheduleOpen(false)} appName={app.name} />
              )}
            </div>

            {/* Meta card */}
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
              }}
              data-testid="meta-card"
            >
              {summary && summary.count > 0 && (
                <MetaRow label="Rating" value={`${summary.avg.toFixed(1)} / 5`} />
              )}
              {app.author && <MetaRow label="Created by" value={`@${app.author}`} />}
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
              <MetaRow label="License" value="Apache 2.0" />
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
        </section>

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

        {/* About + reviews */}
        <section
          style={{
            background: 'var(--card)',
            border: '1px solid var(--line)',
            borderRadius: 14,
            padding: '32px 28px',
            marginBottom: 24,
          }}
        >
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
          <p
            style={{
              fontSize: 14,
              color: 'var(--text-2, var(--muted))',
              margin: 0,
              lineHeight: 1.65,
              marginBottom: 24,
            }}
          >
            {app.description}
          </p>

          {summary && summary.count > 0 && <RatingsWidget summary={summary} />}

          <AppReviews slug={app.slug} />
        </section>

        {/* Connectors row */}
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
              gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
              gap: 16,
            }}
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
            <ConnectorCard
              label="ChatGPT"
              title="Add to ChatGPT"
              desc="Install into a custom GPT."
              testId="connector-chatgpt"
              onClick={() => setComingSoon('chatgpt')}
              comingSoon
            />
            <ConnectorCard
              label="Notion"
              title="Add to Notion"
              desc="Embed as a Notion block."
              testId="connector-notion"
              onClick={() => setComingSoon('notion')}
              comingSoon
            />
            <ConnectorCard
              label="Terminal"
              title="Add to Terminal"
              desc="Run via curl or the floom CLI."
              testId="connector-terminal"
              onClick={() => setComingSoon('terminal')}
              comingSoon
            />
          </div>
        </section>

        {/* Run surface */}
        <section
          id="run"
          data-testid="tab-content-run"
          style={{
            background: 'var(--card)',
            border: '1px solid var(--line)',
            borderRadius: 14,
            padding: '28px 24px',
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
            <FloomApp
              app={app}
              standalone={true}
              showSidebar={false}
              initialRun={initialRun}
              onResetInitialRun={handleResetInitialRun}
            />
          )}
        </section>
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
    </div>
  );
}

/* ----------------- small components ----------------- */

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

function CalendarClock() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h6M16 2v4M8 2v4M3 10h18"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={18} cy={17} r={4} stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M18 15v2l1.5 1"
        stroke="currentColor"
        strokeWidth="1.8"
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

function ScheduleDrawer({ onClose, appName }: { onClose: () => void; appName: string }) {
  return (
    <div
      data-testid="schedule-drawer"
      style={{
        marginTop: 20,
        background: 'var(--accent-soft, var(--bg))',
        border: '1px solid var(--accent-border, var(--line))',
        borderRadius: 14,
        padding: 22,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 8,
            background: 'var(--accent-soft, var(--bg))',
            border: '1px solid var(--accent-border, var(--line))',
            color: 'var(--accent)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <CalendarClock />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>
            Run {appName} on a schedule
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            Pick a frequency, time, and default input. Floom handles the rest.
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close schedule drawer"
          style={{
            padding: 6,
            background: 'transparent',
            border: 'none',
            color: 'var(--muted)',
            cursor: 'pointer',
            fontFamily: 'inherit',
            borderRadius: 6,
          }}
        >
          <svg width={16} height={16} viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: 16,
        }}
      >
        <ScheduleField label="Frequency">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {['Daily', 'Weekdays', 'Weekly', 'Monthly'].map((f) => (
              <span
                key={f}
                style={{
                  padding: '4px 10px',
                  borderRadius: 999,
                  fontSize: 11,
                  fontWeight: 500,
                  border: '1px solid var(--line)',
                  background: 'var(--card)',
                  color: 'var(--muted)',
                }}
              >
                {f}
              </span>
            ))}
          </div>
        </ScheduleField>
        <ScheduleField label="Time">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="text"
              value="09:00"
              readOnly
              style={{
                width: 72,
                padding: '6px 8px',
                border: '1px solid var(--line)',
                borderRadius: 6,
                background: 'var(--card)',
                fontSize: 12,
                color: 'var(--muted)',
                fontFamily: 'inherit',
              }}
            />
            <select
              disabled
              style={{
                padding: '6px 8px',
                border: '1px solid var(--line)',
                borderRadius: 6,
                background: 'var(--card)',
                fontSize: 12,
                color: 'var(--muted)',
                fontFamily: 'inherit',
              }}
            >
              <option>UTC</option>
            </select>
          </div>
        </ScheduleField>
        <ScheduleField label="Run with input from">
          <select
            disabled
            style={{
              padding: '6px 8px',
              border: '1px solid var(--line)',
              borderRadius: 6,
              background: 'var(--card)',
              fontSize: 12,
              color: 'var(--muted)',
              fontFamily: 'inherit',
              width: '100%',
            }}
          >
            <option>Last successful run</option>
          </select>
        </ScheduleField>
      </div>

      <div
        style={{
          marginTop: 18,
          paddingTop: 14,
          borderTop: '1px solid var(--line)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ fontSize: 11, color: 'var(--muted)' }}>
          Scheduling ships with the job queue release. Preview only.
        </div>
        <button
          type="button"
          disabled
          style={{
            padding: '8px 16px',
            background: 'var(--accent)',
            color: '#fff',
            border: 'none',
            borderRadius: 8,
            fontSize: 12,
            fontWeight: 600,
            cursor: 'not-allowed',
            opacity: 0.55,
            fontFamily: 'inherit',
          }}
        >
          Coming soon
        </button>
      </div>
    </div>
  );
}

function ScheduleField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div
        style={{
          fontSize: 10,
          fontWeight: 600,
          color: 'var(--muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.07em',
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      {children}
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
