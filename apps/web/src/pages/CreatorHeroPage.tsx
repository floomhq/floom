import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { TopBar } from '../components/TopBar';
import { PublicFooter } from '../components/public/PublicFooter';
import { AppStripe } from '../components/public/AppStripe';
import { FeedbackButton } from '../components/FeedbackButton';
import { IntegrationLogos } from '../components/home/IntegrationLogos';
// Goosebumps pass 2026-04-20: ArchitectureDiagram removed from landing.
// It was dev-oriented ("ingest -> normalize -> typed manifest -> docker
// runner -> renderer cascade") and the ICP is creators + biz users. The
// conceptual story lives in /protocol docs where readers actually want
// implementation detail. Landing now reads in 20s: hero -> outcomes ->
// apps -> Why (3 cards) -> Layers (5 cards) -> self-host -> built-by.
import { InlineDemo } from '../components/home/InlineDemo';
import { WhyFloom } from '../components/home/WhyFloom';
import { LayersGrid } from '../components/home/LayersGrid';
import { McpSnippet } from '../components/home/McpSnippet';
import { BuiltBy } from '../components/home/BuiltBy';
import { HeroAppTiles } from '../components/home/HeroAppTiles';
import { LaunchAnswers } from '../components/home/LaunchAnswers';
import { ProofRow } from '../components/home/ProofRow';
import { SectionEyebrow } from '../components/home/SectionEyebrow';
import * as api from '../api/client';
import { useSession } from '../hooks/useSession';
import { track } from '../lib/posthog';
import type { DetectedApp, HubApp } from '../lib/types';
import { publicHubApps } from '../lib/hub-filter';
import {
  buildGithubSpecCandidates,
  formatGithubCandidate,
  normalizeGithubUrl,
} from '../lib/githubUrl';

interface Stripe {
  slug: string;
  name: string;
  description: string;
  // Rescue 2026-04-21 (Fix 4): category drives the tile-tint variety
  // on the landing stripes. Optional so the static fallback roster
  // still works even when /api/hub hasn't responded yet.
  category?: string;
}

// P0 launch curation (issue #253, 2026-04-21): the three showcase demos
// are the hero proof-of-life. lead-scorer leads because it is the
// highest-surface-area demo (CSV in, enriched rows + scores + reasoning
// out) and hits the "real work" positioning hardest. Tiles + stripes
// share this roster so the hero teaser and featured section stay in
// sync. /apps/web/src/lib/hub-filter.ts hides everything else from the
// public listings.
const PREFERRED_SLUGS = ['lead-scorer', 'competitor-analyzer', 'resume-screener'] as const;

// Descriptions pulled from each app's floom.yaml manifest on the demo
// feature branches (feature/lead-scorer-demo, feature/competitor-
// analyzer-demo, feature/resume-screener-demo). Kept slightly shorter
// than the full manifest text so the hero tile clamp (~80 chars) and
// the stripe row don't drop mid-clause.
const FALLBACK_STRIPES: Stripe[] = [
  {
    slug: 'lead-scorer',
    name: 'Lead Scorer',
    description:
      'Upload a CSV of leads + your ICP. Get fit scores, reasoning, and enriched columns.',
    category: 'growth',
  },
  {
    slug: 'competitor-analyzer',
    name: 'Competitor Analyzer',
    description:
      'Paste competitor URLs, get positioning, pricing, and a strengths/weaknesses table.',
    category: 'research',
  },
  {
    slug: 'resume-screener',
    name: 'Resume Screener',
    description:
      'Upload a zip of PDFs + a JD, get a ranked shortlist with reasoning per candidate.',
    category: 'growth',
  },
];

const PENDING_KEY = 'floom:pending-publish';

type PendingPublish = {
  detected: DetectedApp;
  name: string;
  slug: string;
  description: string;
  category: string;
  visibility: 'public' | 'private' | 'auth-required';
  source: 'github' | 'openapi';
};

function normalizeLink(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function persistPendingPublish(detected: DetectedApp, source: 'github' | 'openapi') {
  const pending: PendingPublish = {
    detected,
    name: detected.name,
    slug: detected.slug,
    description: detected.description,
    category: detected.category || '',
    visibility: 'public',
    source,
  };
  window.localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
}

function pickStripes(apps: HubApp[]): Stripe[] {
  if (apps.length === 0) return FALLBACK_STRIPES;
  const bySlug = new Map(apps.map((app) => [app.slug, app]));
  const picked: Stripe[] = [];
  for (const slug of PREFERRED_SLUGS) {
    const hit = bySlug.get(slug);
    if (hit) picked.push({ slug: hit.slug, name: hit.name, description: hit.description, category: hit.category ?? undefined });
  }
  // P0 curation (#253): we only ship 3 showcase tiles. If the hub fetch
  // didn't return any of the three, fall back to the static roster so
  // the hero still renders meaningful proof-of-life instead of random
  // first-party utilities.
  if (picked.length === PREFERRED_SLUGS.length) return picked;
  return picked.length >= 3 ? picked : FALLBACK_STRIPES;
}

export function CreatorHeroPage() {
  const navigate = useNavigate();
  const { data: sessionData, isAuthenticated, loading: sessionLoading } = useSession();
  const [sourceLink, setSourceLink] = useState('');
  const [heroError, setHeroError] = useState('');
  const [isDetecting, setIsDetecting] = useState(false);
  const [heroDetectStatus, setHeroDetectStatus] = useState('');
  const [stripes, setStripes] = useState<Stripe[]>(FALLBACK_STRIPES);
  const [hubCount, setHubCount] = useState<number | null>(null);
  // Friction-reduction 2026-04-20: signed-in users see the detect result
  // inline in the hero and can publish in one click without leaving the
  // page. Signed-out users still route through /studio/build (the
  // "Customize" path) so the signup prompt can present the full form.
  const [detected, setDetected] = useState<DetectedApp | null>(null);
  const [isPublishing, setIsPublishing] = useState(false);
  const [publishStatus, setPublishStatus] = useState('');
  const [publishedSlug, setPublishedSlug] = useState<string | null>(null);
  const cloudMode = sessionData?.cloud_mode === true;
  // Self-host bypass for the launch-week SHOWCASE allowlist (see
  // lib/hub-filter.ts). On a self-hosted instance (`cloud_mode: false`)
  // show every app the operator has, not just the three hosted demos.
  const selfHost = sessionData?.cloud_mode === false;

  useEffect(() => {
    document.title = 'Ship AI apps fast · Floom';
    api
      .getHub()
      .then((apps) => {
        // Filter QA/test fixtures so the landing "N apps running right
        // now" matches the /apps directory header count. Single source
        // of truth: lib/hub-filter.ts. Self-host bypasses the hosted
        // SHOWCASE allowlist.
        const visible = publicHubApps(apps, { selfHost });
        setHubCount(visible.length);
        if (visible.length > 0) setStripes(pickStripes(visible));
      })
      .catch(() => {
        // Keep the static roster on failure.
      });
  }, [selfHost]);

  // P0 curation (#253): FALLBACK_STRIPES are authored from the manifests
  // directly, so the old LAUNCH_APPS enrichment (opendraft/openpaper/...)
  // is no longer needed. Render the roster as-is.
  const visibleStripes = stripes;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (sessionLoading) return;
    setHeroError('');
    setDetected(null);
    setPublishedSlug(null);
    setHeroDetectStatus('');

    const rawLink = sourceLink.trim();
    // Analytics (launch-infra #4): fire publish_clicked on every hero
    // Publish CTA submit, before any redirects or detect calls. We
    // forward `has_url` so the funnel distinguishes empty-form clicks
    // (user just exploring /studio/build) from link-backed publishes.
    track('publish_clicked', {
      has_url: rawLink.length > 0,
      authenticated: isAuthenticated,
    });

    if (!rawLink) {
      navigate(
        isAuthenticated
          ? '/studio/build'
          : '/signup?next=' + encodeURIComponent('/studio/build'),
      );
      return;
    }

    // Friction-reduction 2026-04-20: for SIGNED-IN users, resolve the
    // detect inline and morph the hero into a "Found N operations · Ready
    // to publish" card with a single Publish button. No navigation, no
    // second spinner screen on /studio/build. The "Customize" link inside
    // the card still routes to /studio/build for the full form.
    //
    // For SIGNED-OUT users we keep the legacy flow: route to /studio/build
    // (via /signup for anon) so the existing SignupToPublishModal + form
    // owns the handoff. Moving anon-publish to an inline publish-as-draft
    // card needs a schema change (is_draft + TTL sweeper) that we're not
    // doing in this PR.
    // Issue #90: hand off the canonical GitHub URL so BuildPage classifies
    // `owner/repo` as the GitHub ramp instead of routing it through the
    // OpenAPI ramp (where it would 404).
    const handoffUrl = normalizeGithubUrl(rawLink) ?? normalizeLink(rawLink);
    const buildTarget =
      '/studio/build?ingest_url=' + encodeURIComponent(handoffUrl);
    const signedOutFallback = '/signup?next=' + encodeURIComponent(buildTarget);

    if (cloudMode && !isAuthenticated) {
      navigate(signedOutFallback);
      return;
    }

    setIsDetecting(true);
    try {
      window.localStorage.removeItem(PENDING_KEY);
    } catch {
      // Ignore storage failures; the redirect still works for signed-in users.
    }

    try {
      const candidates = buildGithubSpecCandidates(rawLink);
      if (candidates.length > 0) {
        for (const candidate of candidates) {
          try {
            setHeroDetectStatus(`Trying ${formatGithubCandidate(candidate)}…`);
            const d = await api.detectApp(candidate);
            persistPendingPublish(d, 'github');
            if (isAuthenticated) {
              // Morph the hero in-place — no navigation.
              setDetected(d);
              return;
            }
            navigate(signedOutFallback);
            return;
          } catch {
            // Try the next candidate path.
          }
        }
        // All GitHub candidates failed — fall through to the generic
        // build-page path with the URL intact. Signed-in users still see
        // the full form on /studio/build (not a total dead-end).
        navigate(isAuthenticated ? buildTarget : signedOutFallback);
        return;
      }

      // If the input resolved to a GitHub canonical URL earlier, it
      // would have been handled above; anything reaching here is plain
      // OpenAPI (direct spec URL, docs host, etc.).
      setHeroDetectStatus('Fetching the OpenAPI file…');
      const d = await api.detectApp(normalizeLink(rawLink));
      persistPendingPublish(d, 'openapi');
      if (isAuthenticated) {
        setDetected(d);
        return;
      }
      navigate(signedOutFallback);
    } catch (err) {
      // Even on hero-side detect failure, take the user to /studio/build
      // with the URL intact. BuildPage re-runs detect and renders the
      // inline error per the new error taxonomy. This replaces the old
      // "sorry, try again" dead-end at the hero.
      if (err instanceof api.ApiError && err.status >= 500) {
        // 5xx is likely transient — keep them in the hero with a retry hint
        // instead of handing them a broken form downstream.
        setHeroError('We could not read that link right now. Try again in a moment.');
        return;
      }
      navigate(isAuthenticated ? buildTarget : signedOutFallback);
    } finally {
      setIsDetecting(false);
      setHeroDetectStatus('');
    }
  };

  // One-click publish from the inline hero card. Signed-in only (the
  // setDetected path is gated above). Errors fall back to /studio/build
  // with the URL intact so the user can fix the slug collision or adjust
  // visibility with the full form.
  async function handleInlinePublish() {
    if (!detected) return;
    let published = false;
    setIsPublishing(true);
    setPublishStatus('Creating the app page…');
    setHeroError('');
    try {
      const res = await api.ingestApp({
        openapi_url: detected.openapi_spec_url,
        name: detected.name,
        slug: detected.slug,
        description: detected.description,
        category: detected.category || undefined,
        visibility: 'public',
      });
      try {
        window.localStorage.removeItem(PENDING_KEY);
      } catch {
        /* ignore */
      }
      setPublishedSlug(res.slug);
      published = true;
      setPublishStatus(`Live at /p/${res.slug}`);
      // Navigate straight to /p/:slug — that's the "app is live" proof.
      navigate(`/p/${res.slug}`);
    } catch (err) {
      // Slug collision or anything else: route to /studio/build with the
      // URL so the user can resolve it with the full form (suggestions,
      // visibility, custom name). Don't strand them in the hero.
      const rawLink = sourceLink.trim();
      const fallback =
        '/studio/build?ingest_url=' + encodeURIComponent(rawLink);
      if (err instanceof api.ApiError && err.status === 409) {
        // Let them customize in the full form where the slug suggestions
        // already render.
        navigate(fallback);
        return;
      }
      setHeroError(
        (err as Error).message ||
          'We could not publish that. Open the full form to continue.',
      );
    } finally {
      setIsPublishing(false);
      if (!published) setPublishStatus('');
    }
  }

  function handleCustomize() {
    const rawLink = sourceLink.trim();
    navigate('/studio/build?ingest_url=' + encodeURIComponent(rawLink));
  }

  return (
    <div
      className="page-root"
      data-testid="creator-hero"
      style={{ minHeight: '100vh', background: 'var(--bg)' }}
    >
      <TopBar />

      <main id="main" style={{ display: 'block' }}>
        {/* HERO v4 (2026-04-20 deep audit):
            - Integration logos moved ABOVE H1 as a tight "WORKS WITH" strip.
              Gives the hero a visual anchor instead of opening with a
              typography wall.
            - H1 + accent + sub (all locked copy) retained but tightened:
              H1 60px on desktop, 52px on small desktop, 34px on mobile.
            - Dual equal-weight CTAs: Publish your app (primary emerald) +
              Browse 22 live apps (secondary outlined, same padding/height).
              v11 pattern restored.
            - 5-tile app strip directly under the CTAs. This is the single
              biggest structural fix: above-fold proof-of-life in the hero.
            - hero-stats chip removed from hero; promoted to a dedicated
              ProofRow section directly below. */}
        <section
          data-testid="hero"
          style={{
            position: 'relative',
            // Goosebumps pass 2026-04-20: more vertical breathing room.
            // 48->72 top, 56->88 bottom so H1 has space above and the
            // CTA row lands centered in the fold, not crammed at the top.
            padding: '72px 24px 88px',
            background:
              'radial-gradient(ellipse 760px 400px at 50% 26%, rgba(5,150,105,0.06), transparent 70%)',
          }}
        >
          <div
            style={{
              maxWidth: 960,
              margin: '0 auto',
              textAlign: 'center',
            }}
          >
            {/* WORKS WITH logos strip — visual anchor above the typography.
                v11/v16 pattern. Same logos as before, smaller mono label. */}
            <div
              className="hero-works-with"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 14,
                marginBottom: 20,
                flexWrap: 'wrap',
              }}
            >
              <span
                style={{
                  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                  fontSize: 10.5,
                  fontWeight: 600,
                  color: 'var(--muted)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.12em',
                }}
              >
                Works with
              </span>
              <IntegrationLogos variant="inline" />
            </div>

            {/* H1 (locked copy). Goosebumps pass 2026-04-20: sized up to
                72px desktop with tighter tracking so the title hits with
                the weight the copy earns. Linear/Stripe/Vercel reference
                class: serif display face, balanced wrap, deep contrast
                against muted sub-copy. */}
            <h1
              className="hero-headline"
              style={{
                fontFamily: 'var(--font-display)',
                fontWeight: 800,
                fontSize: 72,
                lineHeight: 1.02,
                letterSpacing: '-0.03em',
                color: 'var(--ink)',
                margin: '0 0 20px',
                textWrap: 'balance' as unknown as 'balance',
              }}
            >
              Ship AI apps fast.
            </h1>

            {/* Accent line (locked copy). Goosebumps pass: 17->19 so the
                green accent does real work as the H1's emotional follow. */}
            <p
              className="hero-accent"
              data-testid="hero-accent"
              style={{
                fontFamily: "'Inter', system-ui, sans-serif",
                fontSize: 19,
                lineHeight: 1.35,
                fontWeight: 600,
                letterSpacing: '-0.01em',
                color: 'var(--accent)',
                margin: '0 0 8px',
              }}
            >
              Vibe-coding speed. Production-grade safety.
            </p>

            {/* Sub-positioning (locked copy). */}
            <p
              className="hero-sub-positioning"
              data-testid="hero-sub-positioning"
              style={{
                fontFamily: "'Inter', system-ui, sans-serif",
                fontSize: 15,
                lineHeight: 1.5,
                fontWeight: 400,
                color: 'var(--muted)',
                margin: '0 0 36px',
              }}
            >
              The protocol + runtime for agentic work.
            </p>

            <form
              onSubmit={handleSubmit}
              className="hero-input"
              data-testid="hero-form"
              style={{
                background: 'var(--card)',
                border: '2px solid var(--ink)',
                borderRadius: 16,
                padding: 8,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                boxShadow: '0 4px 0 var(--ink)',
                maxWidth: 620,
                margin: '0 auto',
              }}
            >
              <input
                type="text"
                inputMode="url"
                autoComplete="url"
                spellCheck={false}
                value={sourceLink}
                onChange={(e) => setSourceLink(e.target.value)}
                placeholder="owner/repo or github.com/owner/repo"
                aria-label="Public GitHub repo with OpenAPI, or direct OpenAPI link"
                data-testid="hero-input"
                style={{
                  flex: 1,
                  minWidth: 0,
                  border: 0,
                  outline: 'none',
                  padding: '16px 16px',
                  fontSize: 15,
                  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                  background: 'transparent',
                  color: 'var(--ink)',
                }}
              />
              <button
                type="submit"
                data-testid="hero-cta"
                disabled={isDetecting}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  background: 'var(--accent)',
                  color: '#fff',
                  border: '1px solid var(--accent)',
                  borderRadius: 10,
                  padding: '14px 22px',
                  fontSize: 15,
                  fontWeight: 600,
                  cursor: isDetecting ? 'wait' : 'pointer',
                  opacity: isDetecting ? 0.84 : 1,
                  whiteSpace: 'nowrap',
                  // Goosebumps pass 2026-04-20: subtle inset highlight +
                  // soft outer shadow so the primary CTA reads as pressable,
                  // not painted-on. Matches v6 .btn-primary polish.
                  boxShadow:
                    '0 4px 14px rgba(5,150,105,0.3), inset 0 1px 0 rgba(255,255,255,0.2)',
                }}
              >
                {isDetecting ? 'Checking link...' : 'Publish your app'}
                <ArrowRight size={16} aria-hidden="true" />
              </button>
            </form>

            {isDetecting && heroDetectStatus && (
              <p
                data-testid="hero-detect-status"
                style={{
                  maxWidth: 620,
                  margin: '12px auto 0',
                  color: 'var(--muted)',
                  fontSize: 13,
                  lineHeight: 1.5,
                }}
              >
                {heroDetectStatus}
              </p>
            )}

            {heroError && (
              <p
                data-testid="hero-error"
                style={{
                  maxWidth: 620,
                  margin: '12px auto 0',
                  padding: '12px 14px',
                  borderRadius: 12,
                  border: '1px solid #f3d7bf',
                  background: '#fff7ef',
                  color: '#7a4b19',
                  fontSize: 13,
                  lineHeight: 1.5,
                }}
              >
                {heroError}
              </p>
            )}

            {/* Friction-reduction 2026-04-20: inline publish card.
                Replaces the old "redirect to /studio/build and spin
                again" detour when the caller is signed in. Shows the
                detect summary + a single Publish button + a Customize
                link that routes to the full form. */}
            {detected && !publishedSlug && (
              <div
                data-testid="hero-publish-card"
                style={{
                  maxWidth: 620,
                  margin: '16px auto 0',
                  padding: '16px 18px',
                  borderRadius: 14,
                  border: '1px solid var(--line)',
                  background: 'var(--card)',
                  boxShadow: '0 2px 0 rgba(0,0,0,0.04)',
                  textAlign: 'left',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    justifyContent: 'space-between',
                    gap: 12,
                    marginBottom: 8,
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 15,
                        fontWeight: 700,
                        color: 'var(--ink)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {detected.name}
                    </div>
                    <div
                      style={{
                        fontSize: 12.5,
                        color: 'var(--muted)',
                        marginTop: 2,
                      }}
                    >
                      Found {detected.tools_count || detected.actions.length}{' '}
                      {(detected.tools_count || detected.actions.length) === 1
                        ? 'operation'
                        : 'operations'}{' '}
                      · Ready to publish as <code>/p/{detected.slug}</code>
                    </div>
                  </div>
                </div>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    marginTop: 12,
                    flexWrap: 'wrap',
                  }}
                >
                  <button
                    type="button"
                    onClick={handleInlinePublish}
                    disabled={isPublishing}
                    data-testid="hero-publish"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 8,
                      background: 'var(--accent)',
                      color: '#fff',
                      border: '1px solid var(--accent)',
                      borderRadius: 10,
                      padding: '11px 18px',
                      fontSize: 14,
                      fontWeight: 600,
                      cursor: isPublishing ? 'wait' : 'pointer',
                      opacity: isPublishing ? 0.84 : 1,
                    }}
                  >
                    {isPublishing ? 'Publishing...' : 'Publish'}
                    <ArrowRight size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={handleCustomize}
                    data-testid="hero-customize"
                    style={{
                      background: 'transparent',
                      color: 'var(--muted)',
                      border: '1px solid var(--line)',
                      borderRadius: 10,
                      padding: '10px 14px',
                      fontSize: 13,
                      fontWeight: 500,
                      cursor: 'pointer',
                    }}
                  >
                    Customize
                  </button>
                  <span
                    style={{
                      fontSize: 12,
                      color: 'var(--muted)',
                      marginLeft: 'auto',
                    }}
                  >
                    Public · floom.dev/p/{detected.slug}
                  </span>
                </div>
                {isPublishing && publishStatus && (
                  <div
                    data-testid="hero-publish-status"
                    style={{
                      fontSize: 12,
                      color: 'var(--muted)',
                      marginTop: 10,
                    }}
                  >
                    {publishStatus}
                  </div>
                )}
              </div>
            )}

            <div
              className="hero-cta-row"
              style={{
                marginTop: 16,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 12,
                flexWrap: 'wrap',
              }}
            >
              <Link
                to="/apps"
                data-testid="hero-browse-apps"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  color: 'var(--ink)',
                  fontWeight: 600,
                  textDecoration: 'none',
                  padding: '12px 18px',
                  borderRadius: 10,
                  border: '1px solid var(--line)',
                  background: 'var(--card)',
                  fontSize: 14,
                }}
              >
                Browse{hubCount !== null ? ` ${hubCount}` : ''} live apps
                <ArrowRight size={14} aria-hidden="true" />
              </Link>
              <Link
                to="/docs/self-host"
                data-testid="hero-self-host"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  color: 'var(--muted)',
                  fontWeight: 500,
                  textDecoration: 'underline',
                  textUnderlineOffset: 3,
                  padding: '12px 8px',
                  fontSize: 13.5,
                }}
              >
                Self-host in one command
              </Link>
            </div>

            {/* Hero app-tile strip (new 2026-04-20). Proof-of-life above
                the fold: 4 compact chips showing real live apps, each
                linking to /p/:slug. The fourth tile shows "+N more"
                where N reflects the real hub count (passed via
                totalCount), not the teaser slice of 5. */}
            <HeroAppTiles tiles={visibleStripes} totalCount={hubCount ?? undefined} />
          </div>
        </section>

        {/* PROOF ROW (new 2026-04-20): quantified trust strip. Extracted
            from the hero-stats inline chip into its own breathing-room
            section. */}
        <ProofRow hubCount={hubCount} />

        <LaunchAnswers />

        {/* INLINE DEMO (promoted): the strongest section on the page, now
            the first proof a scrolling user hits after the ProofRow. */}
        <InlineDemo />

        {/* FEATURED APPS (promoted from below-demo). The stripes do the
            heavy lifting; we lead into them with a compact inline header
            and an eyebrow. */}
        <section
          data-testid="try-now-section"
          data-section="featured-apps"
          style={{
            background: 'var(--bg)',
            padding: '72px 24px',
          }}
        >
          <div style={{ maxWidth: 820, margin: '0 auto' }}>
            <header
              className="live-apps-header"
              style={{
                marginBottom: 24,
              }}
            >
              <SectionEyebrow tone="accent" testid="live-apps-eyebrow">
                Live now · open these in a browser
              </SectionEyebrow>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  justifyContent: 'space-between',
                  gap: 16,
                  flexWrap: 'wrap',
                }}
              >
                <h2
                  style={{
                    fontFamily: 'var(--font-display)',
                    fontWeight: 700,
                    fontSize: 34,
                    lineHeight: 1.1,
                    letterSpacing: '-0.02em',
                    color: 'var(--ink)',
                    margin: 0,
                  }}
                >
                  Real apps, running right now.
                </h2>
                <a
                  href="/apps"
                  style={{
                    fontSize: 13.5,
                    color: 'var(--muted)',
                    textDecoration: 'none',
                    fontWeight: 500,
                  }}
                >
                  See every live app →
                </a>
              </div>
            </header>

            <div style={{ display: 'grid', gap: 12 }}>
              {visibleStripes.map((s) => (
                <AppStripe
                  key={s.slug}
                  slug={s.slug}
                  name={s.name}
                  description={s.description}
                  category={s.category}
                  variant="landing"
                />
              ))}
            </div>
          </div>
        </section>

        {/* WHY · problem / solution / proof (now with eyebrows) */}
        <WhyFloom />

        {/* LAYERS · what ships today (now with icon-badges) */}
        <LayersGrid />

        {/* ARCHITECTURE removed 2026-04-20 goosebumps pass — the diagram
            was a dev-speak middle-section that broke the narrative for the
            creator/biz ICP. See imports for full rationale. The conceptual
            story (ingest -> manifest -> runner) lives in /protocol. */}

        {/* MCP SNIPPET · Claude Desktop integration in 3 lines */}
        <McpSnippet />

        {/* SELF-HOST · one docker line + boot output. Simplified caption
            so the ":3051 MCP listening" jargon becomes plain English. */}
        <section
          id="self-host"
          data-testid="self-host-section"
          data-section="self-host"
          style={{
            background: 'var(--card)',
            borderTop: '1px solid var(--line)',
            padding: '72px 24px',
          }}
        >
          <div style={{ maxWidth: 620, margin: '0 auto', textAlign: 'center' }}>
            <SectionEyebrow testid="self-host-eyebrow">
              For the open-source-first
            </SectionEyebrow>
            <h2
              style={{
                fontFamily: 'var(--font-display)',
                fontWeight: 700,
                fontSize: 36,
                lineHeight: 1.1,
                letterSpacing: '-0.02em',
                color: 'var(--ink)',
                margin: '0 0 14px',
              }}
            >
              Run it on your own box.
            </h2>
            <p
              style={{
                fontSize: 15,
                color: 'var(--muted)',
                margin: '0 0 28px',
                lineHeight: 1.55,
              }}
            >
              One line in your terminal. Floom is open source, top to
              bottom. Your data stays with you.
            </p>
            <div
              style={{
                background: 'var(--bg)',
                color: 'var(--ink)',
                border: '1px solid var(--line)',
                borderRadius: 12,
                padding: '20px 22px',
                fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                fontSize: 13.5,
                lineHeight: 1.85,
                textAlign: 'left',
                maxWidth: 560,
                margin: '0 auto',
                overflowX: 'auto',
              }}
            >
              <div>
                <span style={{ color: 'var(--muted)' }}>$</span>{' '}
                <span style={{ color: 'var(--ink)', fontWeight: 600 }}>docker run -p 3051:3051 ghcr.io/floomhq/floom-monorepo:latest</span>
              </div>
              <div style={{ color: 'var(--muted)', marginTop: 6 }}>
                <span style={{ color: 'var(--accent)', fontWeight: 700 }}>✓</span> Floom is up. Browse the full catalog on localhost. Claude integration live.
              </div>
            </div>
            <p style={{ marginTop: 24, fontSize: 14 }}>
              <a
                href="https://github.com/floomhq/floom#self-host"
                target="_blank"
                rel="noreferrer"
                style={{ color: 'var(--muted)', textDecoration: 'underline' }}
              >
                Want the details? Read the self-host guide →
              </a>
            </p>
          </div>
        </section>

        {/* BUILT BY · small credit + github star count */}
        <BuiltBy />
      </main>

      <PublicFooter />
      <FeedbackButton />

      {/* Inline responsive tweaks v4: hero typography shrinks in steps so
         the full hero (logos + H1 + CTA + app tiles) fits on the first
         fold at every viewport. */}
      <style>{`
        /* Goosebumps pass 2026-04-20: step-down sequence from the 72px
           desktop H1. Each step keeps the vertical rhythm (margins
           retained proportionally) so the hero never looks crowded. */
        @media (max-width: 1040px) {
          .hero-headline { font-size: 60px !important; }
        }
        @media (max-width: 780px) {
          .hero-headline { font-size: 48px !important; margin-bottom: 18px !important; }
          .hero-accent { font-size: 17px !important; }
          .hero-works-with { gap: 10px !important; }
        }
        @media (max-width: 640px) {
          [data-testid="hero"] { padding: 52px 20px 60px !important; }
          .hero-headline { font-size: 36px !important; line-height: 1.05 !important; margin-bottom: 14px !important; }
          .hero-accent { font-size: 15px !important; margin-bottom: 6px !important; }
          .hero-sub-positioning { font-size: 14px !important; margin-bottom: 26px !important; }
          .hero-input { flex-direction: column !important; align-items: stretch !important; padding: 10px !important; }
          .hero-input input { padding: 14px !important; font-size: 13.5px !important; }
          .hero-input button { width: 100% !important; padding: 14px !important; justify-content: center !important; }
          .hero-cta-row { flex-direction: column !important; gap: 10px !important; }
          .hero-works-with { margin-bottom: 16px !important; }
          .integration-logos { flex-direction: column !important; gap: 10px !important; }
          .live-apps-header { flex-direction: column !important; align-items: flex-start !important; }
        }
      `}</style>
    </div>
  );
}
