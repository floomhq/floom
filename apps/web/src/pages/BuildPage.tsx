// /build — creator composer. Rebuilt 2026-04-17 to match wireframes.floom.dev
// v11 Screen 5. Multi-ramp entry:
//   1. GitHub import (PRIMARY, full width, functional — transforms repo URL
//      to raw openapi.yaml|json on the fly before calling the detect API).
//   2. OpenAPI URL paste (fallback, functional — the previous behavior).
//   3. Describe it (coming soon — AI generation is deferred per
//      project_floom_positioning.md).
//   4. Connect a tool (coming soon — deferred post-launch).
//   5. Docker image (coming soon — registry pulling ships after v1).
//
// Once a spec is detected the existing review/publish UI runs unchanged.

import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { PageShell } from '../components/PageShell';
import { CustomRendererPanel } from '../components/CustomRendererPanel';
import { useSession } from '../hooks/useSession';
import { useDeployEnabled } from '../lib/flags';
import { ApiError } from '../api/client';
import * as api from '../api/client';
import type { IngestHint } from '../api/client';
import type { DetectedApp } from '../lib/types';
import {
  buildGithubSpecCandidates,
  formatGithubCandidate,
  looksLikeGithubRef,
  normalizeGithubUrl,
  parseGithubRepoRef,
} from '../lib/githubUrl';
import { markJustPublished } from '../lib/onboarding';

type Step = 'ramp' | 'review' | 'publishing' | 'done';

type GithubDetect = { attemptedUrls: string[] } | null;
type DetectKind = 'github' | 'openapi';

// localStorage key for persisting a pending detection across the
// signup redirect so anonymous visitors don't lose their work. Cleared
// once the publish succeeds or the user manually goes back to ramp.
const PENDING_KEY = 'floom:pending-publish';

type PendingPublish = {
  detected: DetectedApp;
  name: string;
  slug: string;
  description: string;
  category: string;
  /** Who can see / run the app in the directory */
  visibility: 'public' | 'private' | 'auth-required';
  source: 'github' | 'openapi';
};

interface BuildPageProps {
  /** Wrapper component used for the outer layout. Defaults to PageShell
   *  (store surface). Studio wraps with StudioLayout. */
  layout?: React.ComponentType<{ children: React.ReactNode; title?: string }>;
  /** Redirect target after publish — Studio sends to /studio/:slug. */
  postPublishHref?: (slug: string) => string;
}

export function BuildPage({
  layout: Layout = PageShell,
  postPublishHref,
}: BuildPageProps = {}) {
  // Launch flag (2026-04-27). When DEPLOY_ENABLED=false on the server
  // we render a waitlist panel instead of the builder. We deliberately
  // do NOT early-return before the state/effect hooks below: React's
  // rules of hooks forbid changing the hook call order across renders,
  // and `deployEnabled` transitions null→true|false once the session
  // loads. Running the full state machine silently is cheap — none of
  // it mounts DOM until we render — and gating the final JSX return
  // keeps the hook order stable.
  const deployEnabled = useDeployEnabled();
  const [searchParams] = useSearchParams();
  const editSlug = searchParams.get('edit');
  // Landing hero hands off the pasted URL via /studio/build?ingest_url=<url>.
  // Legacy: ?openapi=<url> is still accepted so older hero builds and
  // external links keep working. Both pre-populate the matching ramp input
  // and (for ingest_url) auto-trigger detect so the user lands mid-flow
  // with candidate operations already visible.
  const ingestUrlParam = searchParams.get('ingest_url') ?? '';
  const legacyOpenapiParam = searchParams.get('openapi') ?? '';
  const navigate = useNavigate();
  const { data: sessionData, isAuthenticated, loading: sessionLoading } = useSession();
  const [signupPrompt, setSignupPrompt] = useState(false);

  // Classify the hero-provided URL. A github.com URL goes in the GitHub
  // ramp; anything else goes in the OpenAPI ramp. The regex matches both
  // the GitHub owner/repo shape and the direct repo URL.
  const heroUrl = ingestUrlParam || legacyOpenapiParam;
  // Issue #90: looksLikeGithubRef also matches bare `owner/repo`, not just
  // fully-qualified github.com URLs. Keeps the canonical URL match intact.
  const heroIsGithub = looksLikeGithubRef(heroUrl);

  // Inputs shared across ramps
  const [githubUrl, setGithubUrl] = useState(heroIsGithub ? heroUrl : '');
  const [openapiUrl, setOpenapiUrl] = useState(
    !heroIsGithub && heroUrl ? heroUrl : '',
  );
  // Tracks whether we've already kicked off the auto-detect for this
  // mount so we don't re-run it on every render (e.g. when the user
  // manually edits the input after auto-detect).
  const [heroAutoDetected, setHeroAutoDetected] = useState(false);

  // Issue #391 — the publish button was silent while the request ran.
  // `publishing` gates the button's spinner + disabled state INSIDE the
  // review step, before `setStep('publishing')` swaps the whole surface.
  // A separate flag (rather than reading `step`) keeps TypeScript happy:
  // the publish button only renders when `step === 'review'`, so the
  // narrowed type doesn't overlap with 'publishing'.
  const [publishing, setPublishing] = useState(false);
  // Issue #391 — step-by-step status copy rendered inline under the
  // Publish button AND in the full publishing surface. The server doesn't
  // emit SSE/progress events for the ingest pipeline yet, so we cycle
  // through the real backend stages on a heuristic timer (1.5s each).
  // Stages map to the actual ingestApp path: normalize manifest → register
  // app → warm the renderer. The label freezes on the last stage if the
  // request is still in flight after ~4.5s, and `publishSucceeded` flips
  // the copy to "Published ✓" for a brief success flash before the
  // `done` surface takes over.
  const [publishStatus, setPublishStatus] = useState('');
  const [publishSucceeded, setPublishSucceeded] = useState(false);

  // Which ramp submitted last — controls the review heading
  const [source, setSource] = useState<'github' | 'openapi' | null>(null);

  // Detection result
  const [detected, setDetected] = useState<DetectedApp | null>(null);
  const [githubAttempts, setGithubAttempts] = useState<GithubDetect>(null);
  // Issue #390 — brief "Found N operations ✓" success flash before we
  // swap the ramp surface for the review card. ~700 ms so the user reads
  // the outcome instead of seeing the button silently disappear. Cleared
  // when `step` leaves 'ramp'.
  const [detectSucceeded, setDetectSucceeded] = useState<string | null>(null);
  // Issue #390 — detect button had no progress feedback. `detecting`
  // disables the button + swaps the label to "Checking…" while the fetch
  // is in flight; `detectSlow` flips true after 3s so we can surface the
  // "deep paths take up to 10 s" copy for the nested-URL case (issue
  // #389 server fix probes up to 5 candidates with a 10s cumulative
  // budget, so a slow path can run close to the full 10s). Tracking
  // which ramp (github/openapi) is active keeps the progress indicator
  // scoped to the right button.
  const [detecting, setDetecting] = useState<DetectKind | null>(null);
  const [detectStatus, setDetectStatus] = useState('');
  const [detectSlow, setDetectSlow] = useState(false);

  // State machine
  const [step, setStep] = useState<Step>('ramp');
  const [error, setError] = useState<{ message: string; details?: string } | null>(null);
  const [githubError, setGithubError] = useState<
    'private' | 'no-openapi' | 'unreachable' | 'repo-not-found' | null
  >(null);
  // Proactive recovery (MEMORY: feedback_ingestion_be_helpful.md). When
  // the GitHub ramp errors out, we fetch a structured hint from
  // POST /api/hub/detect/hint and render three recovery paths (paste
  // direct URL, paste spec contents, copy a prompt for Claude). This
  // replaces the old dead-end error card.
  const [ingestHint, setIngestHint] = useState<IngestHint | null>(null);
  const [hintLoading, setHintLoading] = useState(false);
  // Which recovery path is open (accordion-style: one at a time).
  const [recoveryMode, setRecoveryMode] = useState<
    'none' | 'direct-url' | 'paste-contents' | 'prompt'
  >('none');
  const [directSpecUrl, setDirectSpecUrl] = useState('');
  const [pastedSpec, setPastedSpec] = useState('');
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [promptCopied, setPromptCopied] = useState(false);
  // Slug-taken recovery (audit 2026-04-20, Fix 2). When the publish
  // request 409s with `slug_taken`, the server returns three suggestions
  // (numeric / version / random suffix). We surface them as clickable
  // pills above the submit button — one click populates the slug field
  // and the user can resubmit. Cleared whenever the user edits the slug
  // manually or after a successful publish.
  const [slugSuggestions, setSlugSuggestions] = useState<string[] | null>(null);

  // Editable metadata (populated after detect)
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  // Issue #129 (2026-04-19): default to Public so the post-publish "share
  // the link" copy matches reality. Creators can still pick Private on the
  // Review step, and can flip it later from /studio/:slug. The old default
  // ('private') contradicted the success banner's "anyone with the link can
  // run this" language.
  const [visibility, setVisibility] = useState<'public' | 'private' | 'auth-required'>(
    'public',
  );

  // Coming-soon state. Round 2 polish: describe/connect ramps removed
  // from the ramp page, so only docker remains as a coming-soon modal
  // target.
  const [comingSoon, setComingSoon] = useState<'docker' | null>(null);
  const cloudMode = sessionData?.cloud_mode === true;

  // Pre-fill if we got here via /build?edit=slug
  useEffect(() => {
    if (!editSlug) return;
    api
      .getApp(editSlug)
      .then((existing) => {
        if (existing) {
          setName(existing.name);
          setSlug(existing.slug);
          setDescription(existing.description);
          setCategory(existing.category || '');
          setStep('ramp');
        }
      })
      .catch(() => {
        /* ignore — show the ramp step */
      });
  }, [editSlug]);

  // Restore a pending detection after signup redirect. Anonymous users can
  // detect + review a spec, then get prompted to sign up when they click
  // Publish — on return, we hydrate the review step from localStorage so
  // they just click Publish again.
  useEffect(() => {
    if (editSlug) return;
    const raw = typeof window !== 'undefined' ? window.localStorage.getItem(PENDING_KEY) : null;
    if (!raw) return;
    try {
      const p = JSON.parse(raw) as PendingPublish;
      setDetected(p.detected);
      setName(p.name);
      setSlug(p.slug);
      setDescription(p.description);
      setCategory(p.category || '');
      setVisibility(p.visibility || 'public');
      setSource(p.source);
      setStep('review');
      // Hydrated from localStorage — don't re-run auto-detect.
      setHeroAutoDetected(true);
    } catch {
      window.localStorage.removeItem(PENDING_KEY);
    }
  }, [editSlug]);

  useEffect(() => {
    if (!detecting) {
      setDetectSlow(false);
      return;
    }
    const id = window.setTimeout(() => setDetectSlow(true), 3000);
    return () => window.clearTimeout(id);
  }, [detecting]);

  // Issue #391 — heuristic progress ticker for the Publish button.
  // No server-side SSE yet, so we cycle through the three real ingest
  // stages every 1.5 s: "Packaging app", "Saving to the directory",
  // "Warming the renderer". The last stage sticks if the request runs
  // long. `publishSucceeded` freezes the ticker on "Published ✓" until
  // the 'done' surface takes over.
  useEffect(() => {
    if (!publishing) return;
    if (publishSucceeded) return;
    const stages = [
      'Packaging app…',
      'Saving to the directory…',
      'Warming the renderer…',
    ];
    let i = 0;
    setPublishStatus(stages[0]);
    const id = window.setInterval(() => {
      i = Math.min(i + 1, stages.length - 1);
      setPublishStatus(stages[i]);
    }, 1500);
    return () => window.clearInterval(id);
  }, [publishing, publishSucceeded]);

  /** Parses a GitHub URL into { owner, repo } or null if it doesn't match.
   *  Issue #90: also accepts bare `owner/repo` via normalizeGithubUrl. */
  function parseGithubUrl(raw: string): { owner: string; repo: string } | null {
    const parsed = parseGithubRepoRef(raw);
    if (!parsed) return null;
    return { owner: parsed.owner, repo: parsed.repo };
  }

  /**
   * Check if a GitHub repo actually exists (and is public). Returns:
   *   - 'exists'    → repo is real and public, proceed to openapi probe
   *   - 'not-found' → repo 404 (typo, deleted, or private w/o access)
   *   - 'unknown'   → network / rate-limit / CORS hiccup; caller should
   *                   treat as "exists" and fall through to the openapi
   *                   probe so a transient GitHub API flake doesn't
   *                   block an otherwise-valid repo.
   *
   * Uses the unauthenticated GitHub REST API (60 req/hr per IP). CORS is
   * open on api.github.com so this works from the browser without a
   * proxy. We intentionally don't parse the response — a 2xx means the
   * repo exists, a 404 means it doesn't, anything else is "unknown".
   */
  async function checkGithubRepoExists(
    owner: string,
    repo: string,
  ): Promise<{ state: 'exists' | 'not-found' | 'unknown'; defaultBranch: string | null }> {
    try {
      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
        method: 'GET',
        headers: { Accept: 'application/vnd.github+json' },
      });
      if (res.status === 404) return { state: 'not-found', defaultBranch: null };
      if (res.ok) {
        let defaultBranch: string | null = null;
        try {
          const payload = (await res.json()) as { default_branch?: string };
          defaultBranch = payload.default_branch || null;
        } catch {
          defaultBranch = null;
        }
        return { state: 'exists', defaultBranch };
      }
      return { state: 'unknown', defaultBranch: null };
    } catch {
      return { state: 'unknown', defaultBranch: null };
    }
  }

  /**
   * Run detect against all GitHub raw-URL candidates, in order. Returns
   * true on success (state updated to `review`); false means every
   * candidate failed and `githubError` was set. Shared between the
   * manual GitHub ramp form and the hero-URL auto-detect on mount.
   *
   * 2026-04-20 (round 2): added an explicit repo-existence probe before
   * the OpenAPI fan-out. Previously, every failure landed on "We couldn't
   * find your app file" — even when the repo itself was 404 — which
   * misled users into checking their spec instead of the URL. Now a
   * real 404 on the repo shows a dedicated "repo not found" error.
   */
  // Fetch a structured recovery hint for the failed GitHub/OpenAPI ramp.
  // Never throws — swallowed errors just leave hint=null and the UI
  // falls back to the generic recovery block with shared defaults.
  async function loadIngestHint(inputUrl: string, attempted: string[]) {
    setHintLoading(true);
    try {
      const hint = await api.fetchIngestHint(inputUrl, attempted);
      setIngestHint(hint);
    } catch {
      setIngestHint(null);
    } finally {
      setHintLoading(false);
    }
  }

  // Try the user's direct spec URL (paste recovery path).
  async function handleDirectSpecUrl() {
    if (!directSpecUrl.trim()) return;
    setRecoveryError(null);
    setRecoveryBusy(true);
    try {
      const result = await api.detectApp(
        directSpecUrl.trim(),
        name || undefined,
        slug || undefined,
      );
      setDetected(result);
      setName(result.name);
      setSlug(result.slug);
      setDescription(result.description);
      setSource('openapi');
      setStep('review');
      setGithubError(null);
      setIngestHint(null);
      setRecoveryMode('none');
    } catch (e) {
      setRecoveryError(
        (e as Error).message ||
          "Couldn't fetch that URL. Make sure it's a public openapi.yaml / openapi.json.",
      );
    } finally {
      setRecoveryBusy(false);
    }
  }

  // Submit pasted spec contents (JSON or YAML string).
  async function handlePastedSpec() {
    const content = pastedSpec.trim();
    if (!content) return;
    setRecoveryError(null);
    setRecoveryBusy(true);
    try {
      const result = await api.detectAppInline(
        content,
        name || undefined,
        slug || undefined,
      );
      setDetected(result);
      setName(result.name);
      setSlug(result.slug);
      setDescription(result.description);
      setSource('openapi');
      setStep('review');
      setGithubError(null);
      setIngestHint(null);
      setRecoveryMode('none');
    } catch (e) {
      setRecoveryError(
        (e as Error).message ||
          "That doesn't look like a valid OpenAPI spec. It needs to declare openapi: 3.x and at least one path.",
      );
    } finally {
      setRecoveryBusy(false);
    }
  }

  async function handleCopyPrompt() {
    const prompt = ingestHint?.ready_prompt;
    if (!prompt) return;
    try {
      await navigator.clipboard.writeText(prompt);
      setPromptCopied(true);
      setTimeout(() => setPromptCopied(false), 2000);
    } catch {
      // clipboard API blocked — fall through, user can still select text
      setPromptCopied(false);
    }
  }

  async function runGithubDetect(inputUrl: string): Promise<boolean> {
    setError(null);
    setGithubError(null);
    setIngestHint(null);
    setRecoveryMode('none');
    setRecoveryError(null);
    setDirectSpecUrl('');
    setPastedSpec('');
    setDetecting('github');
    setDetectStatus('Checking GitHub repo…');
    const parsed = parseGithubUrl(inputUrl);
    if (!parsed) {
      setGithubError('unreachable');
      void loadIngestHint(inputUrl, []);
      setDetecting(null);
      setDetectStatus('');
      return false;
    }

    // Probe repo existence up front. Only block on a definitive 404 —
    // unknowns fall through to the openapi probe so flaky rate-limits
    // don't break happy-path detection.
    const existence = await checkGithubRepoExists(parsed.owner, parsed.repo);
    if (existence.state === 'not-found') {
      setGithubError('repo-not-found');
      void loadIngestHint(inputUrl, []);
      setDetecting(null);
      setDetectStatus('');
      return false;
    }

    const candidates = buildGithubSpecCandidates(inputUrl, {
      defaultBranch: existence.defaultBranch,
    });
    setGithubAttempts({ attemptedUrls: candidates });
    for (const candidate of candidates) {
      try {
        setDetectStatus(`Trying ${formatGithubCandidate(candidate)}…`);
        const result = await api.detectApp(candidate);
        setDetected(result);
        setName(result.name);
        setSlug(result.slug);
        setDescription(result.description);
        setSource('github');
        // Issue #390: brief success flash before we swap to the review
        // surface. Reads the outcome in one glance so the user knows
        // the detect actually worked and the jump isn't a crash.
        await flashDetectSuccess(result.actions.length);
        setStep('review');
        setDetecting(null);
        setDetectStatus('');
        return true;
      } catch {
        // try next
      }
    }
    // Repo confirmed to exist (or unknown) but no OpenAPI spec at any of
    // the candidate paths. Show the no-openapi hint.
    setGithubError('no-openapi');
    void loadIngestHint(inputUrl, candidates);
    setDetecting(null);
    setDetectStatus('');
    return false;
  }

  /**
   * Run detect against an OpenAPI URL. Returns true on success; false
   * sets the inline `error` state. Shared between the manual OpenAPI
   * ramp form and the hero-URL auto-detect on mount.
   *
   * Error classification matches the protocol's error taxonomy (§
   * types.ts ErrorType):
   *   - network_unreachable: fetch failed before any response landed
   *   - user_input_error: upstream 4xx (bad URL, non-JSON content, etc.)
   *   - upstream_outage: upstream 5xx (transient)
   */
  async function runOpenapiDetect(inputUrl: string): Promise<boolean> {
    setError(null);
    setDetecting('openapi');
    setDetectStatus('Fetching the OpenAPI file…');
    try {
      const result = await api.detectApp(inputUrl, name || undefined, slug || undefined);
      setDetected(result);
      setName(result.name);
      setSlug(result.slug);
      setDescription(result.description);
      setSource('openapi');
      // Issue #390: brief "Detected ✓ N operations" flash before the
      // review surface takes over (see runGithubDetect).
      await flashDetectSuccess(result.actions.length);
      setStep('review');
      setDetecting(null);
      setDetectStatus('');
      return true;
    } catch (err) {
      const apiErr = err instanceof api.ApiError ? err : null;
      const is404 = apiErr?.status === 404;

      // Map the raw error to taxonomy-aware copy. The detect endpoint
      // returns 400 with a code when the URL is reachable but the body
      // isn't a valid spec; 0/5xx means the network hop itself failed.
      let message: string;
      if (is404) {
        message = "We couldn't find that spec. Check the URL or try the GitHub ramp.";
      } else if (!apiErr || apiErr.status === 0) {
        message =
          "We couldn't reach that URL. Check the link and try again, or paste your openapi.json directly.";
      } else if (apiErr.status >= 400 && apiErr.status < 500) {
        message =
          apiErr.message ||
          "That URL didn't return a valid OpenAPI spec. Double-check the link.";
      } else {
        message = 'The server returned an error. Try again in a moment.';
      }

      setError({
        message,
        details: (err as Error).message || undefined,
      });
      setDetecting(null);
      setDetectStatus('');
      return false;
    }
  }

  function redirectToDetectLogin(rawUrl: string): void {
    const handoff = normalizeGithubUrl(rawUrl) ?? rawUrl.trim();
    const next =
      '/studio/build?ingest_url=' + encodeURIComponent(handoff);
    navigate('/signup?next=' + encodeURIComponent(next));
  }

  // Issue #390: brief success acknowledgement before we unmount the
  // ramp surface. Without this the button vanishes the moment the API
  // returns, which reads as a page reload instead of a confirmation.
  // ~700 ms is long enough to read ("Detected ✓ 3 operations") without
  // feeling like a delay.
  async function flashDetectSuccess(count: number) {
    const label = `Detected ✓ ${count} ${count === 1 ? 'operation' : 'operations'}`;
    setDetectStatus(label);
    setDetectSucceeded(label);
    await new Promise((resolve) => window.setTimeout(resolve, 700));
    setDetectSucceeded(null);
  }

  // Issue #390: wrap both ramp submit paths with detecting/detectSlow
  // state management so the button can show a spinner + disable + surface
  // the "deep paths take up to 10 s" copy after 3s. A 3s threshold is
  // long enough that a healthy detect (typically <1s) never shows the
  // extra line, and short enough that the nested-URL fallback (which can
  // burn the full 10s budget on issue #389) shows progress well before
  // the request completes.
  async function withDetectFeedback(fn: () => Promise<unknown>): Promise<void> {
    // `runGithubDetect`/`runOpenapiDetect` already manage `detecting`
    // (they set the DetectKind and clear it on finish). This wrapper only
    // owns `detectSlow` — the 3s "can take up to 10 seconds" disclosure.
    setDetectSlow(false);
    const slowTimer = window.setTimeout(() => setDetectSlow(true), 3_000);
    try {
      await fn();
    } finally {
      window.clearTimeout(slowTimer);
      setDetectSlow(false);
    }
  }

  async function handleGithubDetect(e: React.FormEvent) {
    e.preventDefault();
    if (sessionLoading) return;
    if (cloudMode && !isAuthenticated) {
      redirectToDetectLogin(githubUrl);
      return;
    }
    await withDetectFeedback(() => runGithubDetect(githubUrl));
  }

  async function handleOpenapiDetect(e: React.FormEvent) {
    e.preventDefault();
    if (sessionLoading) return;
    if (cloudMode && !isAuthenticated) {
      redirectToDetectLogin(openapiUrl);
      return;
    }
    await withDetectFeedback(() => runOpenapiDetect(openapiUrl));
  }

  // Auto-detect from hero-provided URL (2026-04-20 audit fix). When the
  // landing hero hands off a URL via ?ingest_url=<url>, we pre-fill the
  // matching ramp above and immediately kick off detect so the user
  // sees detected operations without a second click. The conversion
  // killer the audit flagged was a blank /studio/build form after the
  // user typed a URL in the hero. This effect closes that gap.
  //
  // Guards:
  //   - Skip if the user came in via /build?edit=<slug> (already mid-
  //     edit of an existing app).
  //   - Skip if localStorage already re-hydrated a pending detection
  //     (setHeroAutoDetected(true) from the effect above).
  //   - Run exactly once per mount per URL.
  useEffect(() => {
    if (editSlug) return;
    if (!heroUrl) return;
    if (heroAutoDetected) return;
    if (sessionLoading) return;
    if (cloudMode && !isAuthenticated) return;
    // Defer the detect until the next tick so any localStorage-hydrate
    // effect above has a chance to set heroAutoDetected first.
    let cancelled = false;
    setHeroAutoDetected(true);
    (async () => {
      if (cancelled) return;
      await withDetectFeedback(async () => {
        if (heroIsGithub) {
          await runGithubDetect(heroUrl);
        } else {
          await runOpenapiDetect(heroUrl);
        }
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [cloudMode, editSlug, heroAutoDetected, heroIsGithub, heroUrl, isAuthenticated, sessionLoading]);

  async function handlePublish() {
    if (!detected) return;
    // Anonymous users get prompted to sign up before publishing. We
    // persist the review state so they can resume right after auth.
    if (!isAuthenticated) {
      const pending: PendingPublish = {
        detected,
        name,
        slug,
        description,
        category,
        visibility,
        source: source ?? 'openapi',
      };
      try {
        window.localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
      } catch {
        /* storage can fail in private mode; fall back to redirect without resume */
      }
      setSignupPrompt(true);
      return;
    }
    setPublishing(true);
    setPublishSucceeded(false);
    setPublishStatus('Packaging app…');
    setStep('publishing');
    setError(null);
    setSlugSuggestions(null);
    try {
      await api.ingestApp({
        openapi_url: detected.openapi_spec_url,
        name,
        slug,
        description,
        category: category || undefined,
        visibility,
      });
      try {
        window.localStorage.removeItem(PENDING_KEY);
      } catch {
        /* ignore */
      }
      // Issue #255: gate the /p/:slug "Your app is live" celebration
      // to the publisher. Flag is slug-scoped with a 10-minute TTL so
      // a stale flag doesn't fire the celebration for a later visitor.
      markJustPublished(slug);
      // Issue #391: brief "Published ✓" confirmation before swapping to
      // the done surface. ~800 ms — short enough to feel tight, long
      // enough to register as success. Pairs with the ticker useEffect
      // which freezes once publishSucceeded flips true.
      setPublishSucceeded(true);
      setPublishStatus('Published ✓');
      await new Promise((resolve) => window.setTimeout(resolve, 800));
      setPublishing(false);
      setPublishStatus('');
      setPublishSucceeded(false);
      // Studio build: land on the app hub after publish (issue #101).
      if (postPublishHref) {
        navigate(postPublishHref(slug));
        return;
      }
      setStep('done');
      // Non-Studio build: give creators a chance to upload a custom
      // renderer (W2.2) before heading to the permalink. The "Open app"
      // button on the done step handles navigation manually.
    } catch (err) {
      setPublishing(false);
      setPublishStatus('');
      setPublishSucceeded(false);
      setStep('review');
      // Slug-taken: server returns 409 with suggestions (audit 2026-04-20,
      // Fix 2). Render the three pills above the submit button and let
      // the user pick one or keep editing. Any other error keeps the
      // generic inline red message.
      if (err instanceof api.ApiError && err.status === 409 && err.code === 'slug_taken') {
        const payload = err.payload as { suggestions?: string[] } | undefined;
        const suggestions = Array.isArray(payload?.suggestions)
          ? payload!.suggestions.slice(0, 3)
          : [];
        setSlugSuggestions(suggestions.length > 0 ? suggestions : null);
        setError({
          message: `That slug is already taken. Pick one of the suggestions below, or edit the slug field above.`,
          details: err.message,
        });
        return;
      }
      // Issue #391: surface the real server error instead of a generic
      // "Publish failed." toast so creators can act on it (e.g. "your
      // spec URL returned 403" vs. "unknown server error"). Fall back
      // to the generic copy only when the server gave us nothing.
      setError({
        message: humanizePublishError(err),
        details: (err as Error).message || undefined,
      });
    }
  }

  // Apply one of the slug-taken suggestions and immediately retry publish.
  // Wipes the suggestion list so a second collision (vanishingly rare, but
  // possible under concurrent writes) gets a fresh batch.
  async function handleApplySlugSuggestion(next: string) {
    setSlug(next);
    setSlugSuggestions(null);
    // Wait one microtask so React state has committed the new slug before
    // the publish reads from it.
    await Promise.resolve();
    // handlePublish reads from component state which won't see the freshly
    // set `slug` until the next render. We replicate the core publish with
    // the explicit new slug to avoid the stale-state trap.
    if (!detected) return;
    setPublishing(true);
    setPublishSucceeded(false);
    setPublishStatus('Packaging app…');
    setStep('publishing');
    setError(null);
    try {
      await api.ingestApp({
        openapi_url: detected.openapi_spec_url,
        name,
        slug: next,
        description,
        category: category || undefined,
        visibility,
      });
      try {
        window.localStorage.removeItem(PENDING_KEY);
      } catch {
        /* ignore */
      }
      // Issue #255: mark this slug as "just published" so the celebration
      // on /p/:slug fires for the creator, not for every later visitor.
      markJustPublished(next);
      setPublishSucceeded(true);
      setPublishStatus('Published ✓');
      await new Promise((resolve) => window.setTimeout(resolve, 800));
      setPublishing(false);
      setPublishStatus('');
      setPublishSucceeded(false);
      if (postPublishHref) {
        navigate(postPublishHref(next));
        return;
      }
      setStep('done');
    } catch (err) {
      setPublishing(false);
      setPublishStatus('');
      setPublishSucceeded(false);
      setStep('review');
      if (err instanceof api.ApiError && err.status === 409 && err.code === 'slug_taken') {
        const payload = err.payload as { suggestions?: string[] } | undefined;
        const suggestions = Array.isArray(payload?.suggestions)
          ? payload!.suggestions.slice(0, 3)
          : [];
        setSlugSuggestions(suggestions.length > 0 ? suggestions : null);
        setError({
          message: `That slug is also taken. Pick another suggestion or edit manually.`,
          details: err.message,
        });
        return;
      }
      setError({
        message: humanizePublishError(err),
        details: (err as Error).message || undefined,
      });
    }
  }

  // Gate the full builder UI behind the launch flag. When waitlist mode
  // is on, every hook above still ran (to keep the hook order stable),
  // but we never render the ramp/review/publish DOM — we swap in a
  // waitlist panel using the same Layout chrome.
  if (deployEnabled === false) {
    return (
      <Layout title="Join the waitlist | Floom">
        <BuildPageWaitlistPanel />
      </Layout>
    );
  }

  return (
    <Layout title="Publish an app | Floom">
      <div data-testid="build-page" style={{ maxWidth: 1040, margin: '0 auto' }}>
        {/* Header.
            2026-04-20 nav unification: the "← Creator dashboard"
            breadcrumb that used to live here was killed. /studio/build
            now only has ONE back affordance: the Store/Studio pill in
            the TopBar. The old breadcrumb duplicated what the header
            already communicated. */}
        <div style={{ marginBottom: 32 }}>
          <h1
            style={{
              fontSize: 32,
              fontWeight: 700,
              margin: '0 0 8px',
              color: 'var(--ink)',
              letterSpacing: '-0.02em',
            }}
          >
            {editSlug ? `Edit ${editSlug}` : 'Publish a Floom app'}
          </h1>
          <p
            style={{
              fontSize: 15,
              color: 'var(--muted)',
              margin: 0,
              maxWidth: 620,
              lineHeight: 1.55,
            }}
          >
            Start from an idea or a tool you already use. Floom handles the boring stuff for you:
            sign-in, who can use it, history, versions, and a public page. From day one.
          </p>
        </div>

        {/* Step indicator (only visible in review/publish flow) */}
        {step !== 'ramp' && (
          <div
            style={{
              display: 'flex',
              gap: 8,
              marginBottom: 28,
              fontSize: 12,
              color: 'var(--muted)',
              flexWrap: 'wrap',
            }}
          >
            <StepBadge active={false} done={true} label="1. Find your app" />
            <StepBadge
              active={step === 'review'}
              done={step === 'publishing' || step === 'done'}
              label="2. Review"
            />
            <StepBadge active={step === 'publishing'} done={step === 'done'} label="3. Publish" />
          </div>
        )}

        {/* Ramp selection (initial state) */}
        {step === 'ramp' && (
          <div data-testid="build-step-ramp">
            {cloudMode && !isAuthenticated && (
              <div
                data-testid="build-auth-required"
                style={{
                  background: '#fff8e6',
                  border: '1px solid #f4e0a5',
                  color: '#755a00',
                  borderRadius: 12,
                  padding: '14px 16px',
                  marginBottom: 16,
                  fontSize: 13,
                  lineHeight: 1.6,
                }}
              >
                Sign in to inspect and publish apps in cloud mode. Your pasted URL stays here after you come back.
              </div>
            )}

            {/* RAMP 1 — GitHub import (PRIMARY) */}
            <form
              onSubmit={handleGithubDetect}
              data-testid="ramp-github"
              style={{
                background: 'var(--card)',
                border: '1px solid var(--accent-border, var(--line))',
                borderRadius: 16,
                padding: 24,
                marginBottom: 20,
                boxShadow: '0 10px 30px rgba(5,150,105,0.08)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  marginBottom: 14,
                  flexWrap: 'wrap',
                }}
              >
                <div
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 10,
                    background: 'var(--accent-soft)',
                    color: 'var(--accent)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  <GithubIcon size={18} />
                </div>
                <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--ink)' }}>
                  Import from GitHub
                </div>
                <span
                  style={{
                    padding: '3px 10px',
                    borderRadius: 999,
                    background: 'var(--accent-soft)',
                    color: 'var(--accent)',
                    fontSize: 11,
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                  }}
                >
                  Recommended
                </span>
                <span
                  style={{
                    marginLeft: 'auto',
                    padding: '3px 10px',
                    borderRadius: 999,
                    background: 'var(--bg)',
                    border: '1px solid var(--line)',
                    color: 'var(--muted)',
                    fontSize: 11,
                    fontWeight: 500,
                  }}
                >
                  30 seconds
                </span>
              </div>
              <p
                style={{
                  fontSize: 13,
                  color: 'var(--muted)',
                  margin: '0 0 18px',
                  lineHeight: 1.55,
                  maxWidth: 620,
                }}
              >
                Paste your repo URL. Floom reads it and turns it into a live app: a Claude tool,
                a page to share, and a URL your teammates can hit.
              </p>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '4px 6px 4px 12px',
                  border: '1px solid var(--line)',
                  borderRadius: 10,
                  background: 'var(--bg)',
                  marginBottom: 14,
                  flexWrap: 'nowrap',
                }}
              >
                <GithubIcon size={14} />
                <input
                  type="text"
                  value={githubUrl}
                  onChange={(e) => setGithubUrl(e.target.value)}
                  required
                  placeholder="owner/repo or https://github.com/owner/repo"
                  data-testid="build-github-url"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    padding: '10px 4px',
                    border: 'none',
                    background: 'transparent',
                    fontSize: 14,
                    fontFamily: 'JetBrains Mono, monospace',
                    color: 'var(--ink)',
                    outline: 'none',
                  }}
                />
                <button
                  type="submit"
                  data-testid="build-github-detect"
                  disabled={
                    !githubUrl || sessionLoading || detecting !== null || detectSucceeded !== null
                  }
                  aria-busy={detecting === 'github'}
                  style={{
                    padding: '8px 14px',
                    background: 'var(--accent)',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 8,
                    fontSize: 12,
                    fontWeight: 600,
                    cursor:
                      !githubUrl || sessionLoading || detecting !== null || detectSucceeded !== null
                        ? 'not-allowed'
                        : 'pointer',
                    opacity:
                      !githubUrl || sessionLoading || detecting !== null || detectSucceeded !== null
                        ? 0.55
                        : 1,
                    fontFamily: 'inherit',
                    flexShrink: 0,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  {detecting === 'github' ? <Spinner size={12} /> : null}
                  {detecting === 'github'
                    ? detectSlow
                      ? 'Detecting OpenAPI spec…'
                      : 'Detecting…'
                    : 'Detect'}
                </button>
              </div>
              {(detecting === 'github' || detectSucceeded) && (
                <div
                  data-testid="build-github-progress"
                  role="status"
                  aria-live="polite"
                  style={{
                    fontSize: 12,
                    color: detectSucceeded ? 'var(--accent)' : 'var(--muted)',
                    fontWeight: detectSucceeded ? 600 : 400,
                    marginBottom: 10,
                  }}
                >
                  {detectSucceeded || detectStatus}
                  {!detectSucceeded && detectSlow
                    ? ' Still looking, this can take up to 10 seconds.'
                    : ''}
                </div>
              )}
              <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                Works with any public repo. Private repos coming soon.
              </div>

              {/* Proactive recovery block (MEMORY:
                  feedback_ingestion_be_helpful.md). Replaces the prior
                  dead-end ErrorCard. Always surfaces three actions:
                  (1) paste a direct spec URL, (2) paste spec contents,
                  (3) copy a prompt for Claude. The server-backed hint
                  provides repo context + ready prompt + upload URL. */}
              {githubError && (
                <RecoveryBlock
                  testid={`github-error-${githubError}`}
                  kind={githubError}
                  hint={ingestHint}
                  hintLoading={hintLoading}
                  pathsTriedFallback={githubAttempts?.attemptedUrls || []}
                  recoveryMode={recoveryMode}
                  setRecoveryMode={setRecoveryMode}
                  directSpecUrl={directSpecUrl}
                  setDirectSpecUrl={setDirectSpecUrl}
                  pastedSpec={pastedSpec}
                  setPastedSpec={setPastedSpec}
                  onDirectSubmit={handleDirectSpecUrl}
                  onPasteSubmit={handlePastedSpec}
                  onCopyPrompt={handleCopyPrompt}
                  promptCopied={promptCopied}
                  busy={recoveryBusy}
                  error={recoveryError}
                />
              )}
            </form>

            {/* RAMP 2 — OpenAPI URL paste (FUNCTIONAL). Round 2 polish
                (UI audit v2): previously hidden behind a "More ways to
                add an app (coming soon)" accordion that made the
                functional OpenAPI ramp invisible above the fold. Promote
                it directly under the primary GitHub card so both working
                ramps are side-by-side and no "coming soon" copy appears
                above the first real input. */}
            <form
              onSubmit={handleOpenapiDetect}
              data-testid="ramp-openapi"
              style={{
                background: 'var(--card)',
                border: '1px solid var(--line)',
                borderRadius: 14,
                padding: 22,
                marginTop: 16,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                <div
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 8,
                    background: 'var(--bg)',
                    border: '1px solid var(--line)',
                    color: 'var(--muted)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  <FileIcon />
                </div>
                <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--ink)' }}>
                  Paste your app's link
                </div>
              </div>
              <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 12px', lineHeight: 1.55 }}>
                Direct link to your app's openapi.json or openapi.yaml file.
              </p>
              <input
                type="url"
                value={openapiUrl}
                onChange={(e) => setOpenapiUrl(e.target.value)}
                required
                placeholder="https://api.example.com/openapi.json"
                data-testid="build-url-input"
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  border: '1px solid var(--line)',
                  borderRadius: 8,
                  background: 'var(--bg)',
                  fontSize: 14,
                  color: 'var(--ink)',
                  fontFamily: 'JetBrains Mono, monospace',
                  marginBottom: 12,
                  boxSizing: 'border-box',
                }}
              />
              {error && (
                <div
                  data-testid="build-error"
                  style={{
                    margin: '0 0 12px',
                    padding: '10px 14px',
                    background: '#fdecea',
                    border: '1px solid #f4b7b1',
                    color: '#c2321f',
                    borderRadius: 8,
                    fontSize: 13,
                  }}
                >
                  <div style={{ fontWeight: 500 }}>{error.message}</div>
                  {error.details && (
                    <details
                      data-testid="build-error-details"
                      style={{ marginTop: 6, fontSize: 11, opacity: 0.8 }}
                    >
                      <summary style={{ cursor: 'pointer' }}>Technical details</summary>
                      <div
                        style={{
                          marginTop: 4,
                          fontFamily: 'JetBrains Mono, monospace',
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-all',
                        }}
                      >
                        {error.details}
                      </div>
                    </details>
                  )}
                </div>
              )}
              <button
                type="submit"
                data-testid="build-detect"
                disabled={
                  !openapiUrl || sessionLoading || detecting !== null || detectSucceeded !== null
                }
                aria-busy={detecting === 'openapi'}
                style={{
                  ...primaryButton(
                    !openapiUrl ||
                      sessionLoading ||
                      detecting !== null ||
                      detectSucceeded !== null,
                  ),
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                {detecting === 'openapi' ? <Spinner size={13} /> : null}
                {detecting === 'openapi'
                  ? detectSlow
                    ? 'Detecting OpenAPI spec…'
                    : 'Detecting…'
                  : 'Find it'}
              </button>
              {(detecting === 'openapi' || detectSucceeded) && (
                <div
                  data-testid="build-openapi-progress"
                  role="status"
                  aria-live="polite"
                  style={{
                    fontSize: 12,
                    color: detectSucceeded ? 'var(--accent)' : 'var(--muted)',
                    fontWeight: detectSucceeded ? 600 : 400,
                    marginTop: 10,
                  }}
                >
                  {detectSucceeded || detectStatus}
                  {!detectSucceeded && detectSlow
                    ? ' Still looking, this can take up to 10 seconds.'
                    : ''}
                </div>
              )}
              {/* Issue #390: after 3 s, surface the "deep paths can take
                  up to 10 s" copy so the user knows the fallback probe
                  (issue #389) is still running rather than silently stuck. */}
              {detectSlow && detecting === 'openapi' && !detectSucceeded && (
                <div
                  data-testid="build-detect-slow"
                  style={{
                    marginTop: 8,
                    fontSize: 12,
                    color: 'var(--muted)',
                  }}
                >
                  This can take up to 10 seconds for deep paths.
                </div>
              )}
            </form>

            {/* More-ways footer — single collapsed disclosure after the
                functional ramps. Round 2 polish (UI audit v2): Docker
                + other non-shipping ramps must not be visible above the
                fold at 1440x900, so they live inside a closed <details>
                the creator can expand. This keeps "coming soon" copy
                off the initial view while leaving the Docker ramp
                discoverable. */}
            <details
              data-testid="build-more-ways-footer"
              style={{
                marginTop: 24,
                border: '1px solid var(--line)',
                borderRadius: 12,
                background: 'var(--bg)',
                padding: '0 4px',
              }}
            >
              <summary
                data-testid="build-more-ways-summary"
                style={{
                  cursor: 'pointer',
                  padding: '12px 14px',
                  fontSize: 13,
                  fontWeight: 500,
                  color: 'var(--muted)',
                  userSelect: 'none',
                }}
              >
                More ways to add an app
              </summary>
              <div style={{ padding: '4px 12px 16px' }}>
                <RampCard
                  icon={<DockerIcon />}
                  title="Import from a Docker image"
                  badge="Coming soon"
                  desc="Paste an image and the path to your app file. Floom pulls it, scans it, and runs it for you."
                  testId="ramp-docker"
                  onClick={() => setComingSoon('docker')}
                  compact
                >
                  <div
                    style={{
                      display: 'flex',
                      gap: 8,
                      opacity: 0.5,
                      flexWrap: 'wrap',
                      pointerEvents: 'none',
                    }}
                  >
                    <input
                      disabled
                      tabIndex={-1}
                      placeholder="ghcr.io/you/app:latest"
                      style={{
                        flex: '2 1 220px',
                        padding: '10px 12px',
                        border: '1px solid var(--line)',
                        borderRadius: 8,
                        background: 'var(--bg)',
                        fontSize: 13,
                        color: 'var(--muted)',
                        fontFamily: 'JetBrains Mono, monospace',
                        boxSizing: 'border-box',
                        cursor: 'not-allowed',
                      }}
                    />
                    <input
                      disabled
                      tabIndex={-1}
                      placeholder="/openapi.yaml"
                      style={{
                        flex: '1 1 140px',
                        padding: '10px 12px',
                        border: '1px solid var(--line)',
                        borderRadius: 8,
                        background: 'var(--bg)',
                        fontSize: 13,
                        color: 'var(--muted)',
                        fontFamily: 'JetBrains Mono, monospace',
                        boxSizing: 'border-box',
                        cursor: 'not-allowed',
                      }}
                    />
                  </div>
                </RampCard>
                <p
                  style={{
                    marginTop: 12,
                    marginBottom: 0,
                    fontSize: 12.5,
                    color: 'var(--muted)',
                    lineHeight: 1.55,
                  }}
                >
                  Describe-it and tool connectors ship with v1.1.{' '}
                  <a
                    href="/protocol"
                    style={{ color: 'var(--accent)', textDecoration: 'none', fontWeight: 500 }}
                  >
                    Post to the roadmap &rarr;
                  </a>
                </p>
              </div>
            </details>
          </div>
        )}

        {/* Review step — 2026-04-20 redesign: zero-friction publish.
            The default surface shows only a "Ready to publish" summary
            and a primary Publish button above the fold. The detected
            operations (developer jargon) and all editable fields live
            inside two collapsed <details> disclosures so the 95% case
            is one click. Testids (build-publish, detected-actions,
            build-step-review, build-name, build-slug, build-description,
            build-category, build-visibility) are preserved so the
            onboarding Tour and any external harnesses still work. */}
        {step === 'review' && detected && (
          <div data-testid="build-step-review">
            {/* Above-the-fold summary card. One line title, one line
                description, one primary action. Everything else is
                tucked below and collapsed by default. */}
            <div
              data-testid="build-ready-card"
              style={{
                background: 'var(--card)',
                border: '1px solid var(--accent-border, #b5dcc4)',
                borderRadius: 14,
                padding: '22px 24px',
                marginBottom: 16,
                boxShadow: '0 10px 30px rgba(5,150,105,0.08)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 12,
                  color: '#1a7f37',
                  fontWeight: 600,
                  marginBottom: 10,
                  letterSpacing: '0.02em',
                  textTransform: 'uppercase',
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 20,
                    height: 20,
                    borderRadius: 999,
                    background: '#e6f4ea',
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path
                      d="M3 8l3 3 7-7"
                      stroke="#1a7f37"
                      strokeWidth="2.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
                Ready to publish
              </div>
              <h2
                data-testid="build-ready-name"
                style={{
                  fontSize: 22,
                  fontWeight: 700,
                  margin: '0 0 6px',
                  color: 'var(--ink)',
                  letterSpacing: '-0.01em',
                }}
              >
                {name || 'Untitled app'}
              </h2>
              <p
                data-testid="build-ready-tagline"
                style={{
                  margin: '0 0 18px',
                  fontSize: 14,
                  color: 'var(--muted)',
                  lineHeight: 1.5,
                  // Show a single-line tagline. The full README-derived
                  // description still lives (editable) inside the
                  // "Edit details" disclosure below.
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                }}
              >
                {firstSentence(description) || 'No description yet. Edit details to add one.'}
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <VisibilityChooser
                  value={visibility}
                  onChange={(next) => setVisibility(next)}
                />
                <div>
                  <button
                    type="button"
                    onClick={handlePublish}
                    data-testid="build-publish"
                    disabled={!name || !slug || publishing}
                    aria-busy={publishing}
                    style={{
                      ...primaryButton(!name || !slug || publishing),
                      background: 'var(--accent)',
                      padding: '12px 22px',
                      fontSize: 14,
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 8,
                    }}
                  >
                    {publishing ? <Spinner size={13} /> : null}
                    {publishing ? 'Publishing…' : publishButtonLabel(visibility)}
                  </button>
                  {/* Issue #391: inline status line below the Publish
                      button so the brief window between click and the
                      full 'publishing' surface isn't silent. The same
                      status feeds the full surface below (see
                      step === 'publishing'). */}
                  {publishing && publishStatus && (
                    <div
                      data-testid="build-publish-progress"
                      role="status"
                      aria-live="polite"
                      style={{
                        marginTop: 10,
                        fontSize: 12,
                        color: publishSucceeded ? 'var(--accent)' : 'var(--muted)',
                        fontWeight: publishSucceeded ? 600 : 400,
                      }}
                    >
                      {publishStatus}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Disclosure: detected actions. Collapsed by default. Shows
                the raw operation names (developer jargon) only on click. */}
            <details
              data-testid="build-actions-disclosure"
              style={{
                background: 'var(--card)',
                border: '1px solid var(--line)',
                borderRadius: 12,
                padding: '0 4px',
                marginBottom: 12,
              }}
            >
              <summary
                data-testid="build-actions-summary"
                style={{
                  cursor: 'pointer',
                  listStyle: 'none',
                  padding: '14px 18px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  fontSize: 13,
                  color: 'var(--muted)',
                  userSelect: 'none',
                }}
              >
                <Chevron />
                <span style={{ fontWeight: 500, color: 'var(--ink)' }}>
                  {detected.tools_count} action{detected.tools_count === 1 ? '' : 's'} detected
                </span>
                <span>·</span>
                <span>
                  sign-in:{' '}
                  <code style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                    {detected.auth_type || 'none'}
                  </code>
                </span>
                {source === 'github' && (
                  <span style={{ marginLeft: 'auto', fontSize: 12 }}>
                    Imported from GitHub
                  </span>
                )}
              </summary>
              <ul
                style={{
                  margin: 0,
                  padding: '0 18px 16px 40px',
                  listStyle: 'none',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                  maxHeight: 220,
                  overflowY: 'auto',
                }}
                data-testid="detected-actions"
              >
                {detected.actions.slice(0, 20).map((a) => (
                  <li
                    key={a.name}
                    style={{
                      fontSize: 13,
                      color: 'var(--ink)',
                      fontFamily: 'JetBrains Mono, monospace',
                    }}
                  >
                    <strong>{a.name}</strong>
                    {a.description && (
                      <span style={{ color: 'var(--muted)', fontFamily: 'Inter, sans-serif' }}>
                        {' '}
                        : {a.description}
                      </span>
                    )}
                  </li>
                ))}
                {detected.actions.length > 20 && (
                  <li style={{ fontSize: 12, color: 'var(--muted)' }}>
                    …and {detected.actions.length - 20} more
                  </li>
                )}
              </ul>
            </details>

            {/* Disclosure: edit details. Collapsed by default. Contains
                name, slug, description, category — the full metadata. */}
            <details
              data-testid="build-details-disclosure"
              style={{
                background: 'var(--card)',
                border: '1px solid var(--line)',
                borderRadius: 12,
                padding: '0 4px',
                marginBottom: 12,
              }}
            >
              <summary
                data-testid="build-details-summary"
                style={{
                  cursor: 'pointer',
                  listStyle: 'none',
                  padding: '14px 18px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  fontSize: 13,
                  color: 'var(--ink)',
                  fontWeight: 500,
                  userSelect: 'none',
                }}
              >
                <Chevron />
                Edit details
                <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 400 }}>
                  (name, slug, description, category)
                </span>
              </summary>
              <div style={{ padding: '4px 18px 20px' }}>
                <Label>App name</Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  data-testid="build-name"
                />

                <Label>Slug (URL path)</Label>
                <Input
                  value={slug}
                  onChange={(e) => {
                    setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'));
                    if (slugSuggestions) setSlugSuggestions(null);
                  }}
                  data-testid="build-slug"
                />

                <Label>Description</Label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={5}
                  data-testid="build-description"
                  style={{
                    width: '100%',
                    padding: '10px 12px',
                    border: '1px solid var(--line)',
                    borderRadius: 8,
                    background: 'var(--card)',
                    fontSize: 14,
                    color: 'var(--ink)',
                    fontFamily: 'inherit',
                    resize: 'vertical',
                    minHeight: 120,
                    boxSizing: 'border-box',
                  }}
                />

                <Label>Category (optional)</Label>
                <Input
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  placeholder="e.g. travel, coding, productivity"
                  data-testid="build-category"
                />

                <p style={{ fontSize: 12, color: 'var(--muted)', margin: '14px 0 0' }}>
                  You can flip visibility later from{' '}
                  <span style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                    /studio/{slug || '…'}
                  </span>
                  .
                </p>
              </div>
            </details>

            {error && (
              <div
                data-testid="build-error"
                style={{
                  margin: '0 0 12px',
                  padding: '10px 14px',
                  background: '#fdecea',
                  border: '1px solid #f4b7b1',
                  color: '#c2321f',
                  borderRadius: 8,
                  fontSize: 13,
                }}
              >
                <div style={{ fontWeight: 500 }}>{error.message}</div>
                {error.details && (
                  <details
                    data-testid="build-error-details"
                    style={{ marginTop: 6, fontSize: 11, opacity: 0.8 }}
                  >
                    <summary style={{ cursor: 'pointer' }}>Technical details</summary>
                    <div
                      style={{
                        marginTop: 4,
                        fontFamily: 'JetBrains Mono, monospace',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-all',
                      }}
                    >
                      {error.details}
                    </div>
                  </details>
                )}
              </div>
            )}

            {/* Slug-taken recovery pills (audit 2026-04-20, Fix 2).
                Rendered only when the server returned 409 slug_taken.
                Clicking a pill writes the suggestion into the slug field
                and retries publish immediately. */}
            {slugSuggestions && slugSuggestions.length > 0 && (
              <div
                data-testid="build-slug-suggestions"
                style={{
                  marginBottom: 12,
                  padding: '12px 14px',
                  background: '#fff7ed',
                  border: '1px solid #fcd9ae',
                  borderRadius: 10,
                }}
              >
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: '#7a4b19',
                    marginBottom: 8,
                    letterSpacing: '0.01em',
                  }}
                >
                  Try one of these:
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {slugSuggestions.map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      onClick={() => handleApplySlugSuggestion(suggestion)}
                      data-testid={`build-slug-suggestion-${suggestion}`}
                      style={{
                        padding: '6px 14px',
                        background: 'var(--card)',
                        border: '1px solid var(--accent, #10b981)',
                        borderRadius: 999,
                        fontSize: 13,
                        fontWeight: 600,
                        color: 'var(--accent, #10b981)',
                        cursor: 'pointer',
                        fontFamily: 'JetBrains Mono, monospace',
                      }}
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
                <p
                  style={{
                    margin: '10px 0 0',
                    fontSize: 11.5,
                    color: 'var(--muted)',
                    lineHeight: 1.5,
                  }}
                >
                  Click a suggestion to publish with that slug, or edit the field above.
                </p>
              </div>
            )}

            <div style={{ marginTop: 8 }}>
              <button
                type="button"
                onClick={() => {
                  try {
                    window.localStorage.removeItem(PENDING_KEY);
                  } catch {
                    /* ignore */
                  }
                  setStep('ramp');
                }}
                style={{
                  padding: '8px 14px',
                  background: 'transparent',
                  border: 'none',
                  fontSize: 12.5,
                  color: 'var(--muted)',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  textDecoration: 'underline',
                }}
              >
                Start over
              </button>
            </div>
          </div>
        )}

        {step === 'publishing' && (
          <div
            data-testid="build-step-publishing"
            role="status"
            aria-live="polite"
            aria-busy={!publishSucceeded}
            style={{ padding: 40, textAlign: 'center' }}
          >
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 10,
                padding: '14px 18px',
                borderRadius: 12,
                background: 'var(--card)',
                border: '1px solid var(--line)',
                color: 'var(--ink)',
                fontSize: 14,
                fontWeight: 500,
                minWidth: 240,
              }}
            >
              {publishSucceeded ? (
                <span
                  aria-hidden="true"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 20,
                    height: 20,
                    borderRadius: 999,
                    background: '#e6f4ea',
                    color: '#1a7f37',
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                    <path
                      d="M3 8l3 3 7-7"
                      stroke="currentColor"
                      strokeWidth="2.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
              ) : (
                <Spinner size={14} />
              )}
              <span style={{ color: publishSucceeded ? '#1a7f37' : 'var(--ink)' }}>
                {publishStatus || 'Publishing…'}
              </span>
            </div>
            {!publishSucceeded && (
              <p style={{ marginTop: 14, fontSize: 12.5, color: 'var(--muted)' }}>
                This usually takes a few seconds.
              </p>
            )}
          </div>
        )}

        {step === 'done' && (
          <div data-testid="build-step-done">
            <div
              style={{
                padding: 24,
                textAlign: 'center',
                background: '#e6f4ea',
                border: '1px solid #b5dcc4',
                borderRadius: 12,
                marginBottom: 20,
              }}
            >
              <div style={{ color: '#1a7f37', fontSize: 20, fontWeight: 700, marginBottom: 8 }}>
                Published
              </div>
              <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 14px' }}>
                {visibility === 'private'
                  ? 'Your app is live. Only you can run it while signed in. You can flip it to Public later if you want to share.'
                  : visibility === 'auth-required'
                    ? 'Your app is live. Any signed-in Floom user can run it via the link. It is hidden from the public store.'
                    : 'Your app is live. Share the link or add it to Claude Desktop to start running it.'}
              </p>
              {/* Shareable full URL + copy button. Before this fix the
                  banner only showed "/p/slug" relative path, which is not
                  shareable outside the current tab. */}
              <ShareableUrl slug={slug} />
              <div style={{ display: 'flex', justifyContent: 'center', gap: 10, flexWrap: 'wrap', marginTop: 14 }}>
                <button
                  type="button"
                  onClick={() => navigate(`/p/${slug}`)}
                  className="btn-primary"
                  data-testid="build-open-app"
                  style={{ padding: '9px 16px', fontSize: 13 }}
                >
                  Open app
                </button>
                <Link
                  to={postPublishHref ? postPublishHref(slug) : `/me/apps/${slug}`}
                  className="btn-ghost"
                  data-testid="build-install-claude"
                  style={{
                    padding: '9px 14px',
                    fontSize: 13,
                    border: '1px solid var(--line)',
                    borderRadius: 8,
                    textDecoration: 'none',
                  }}
                >
                  {postPublishHref ? 'Manage in Studio' : 'Install in Claude'}
                </Link>
                {!postPublishHref && (
                  <Link
                    to={`/creator/${slug}`}
                    className="btn-ghost"
                    style={{
                      padding: '9px 14px',
                      fontSize: 13,
                      border: '1px solid var(--line)',
                      borderRadius: 8,
                      textDecoration: 'none',
                    }}
                  >
                    View in creator dashboard
                  </Link>
                )}
              </div>
            </div>

            <div
              style={{
                background: 'var(--card)',
                border: '1px solid var(--line)',
                borderRadius: 12,
                padding: 20,
              }}
            >
              <CustomRendererPanel slug={slug} />
            </div>
          </div>
        )}
      </div>

      {comingSoon && (
        <ComingSoonRampModal target={comingSoon} onClose={() => setComingSoon(null)} />
      )}

      {signupPrompt && (
        <SignupToPublishModal
          onClose={() => setSignupPrompt(false)}
          onContinue={() => navigate('/signup?next=' + encodeURIComponent('/build'))}
          onSignIn={() => navigate('/login?next=' + encodeURIComponent('/build'))}
        />
      )}
    </Layout>
  );
}

/* -------------------------- subcomponents -------------------------- */

function RampCard({
  icon,
  title,
  badge,
  desc,
  onClick,
  testId,
  children,
  compact,
}: {
  icon: React.ReactNode;
  title: string;
  badge: string;
  desc: string;
  onClick: () => void;
  testId: string;
  children?: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      style={{
        background: 'var(--card)',
        border: '1px solid var(--line)',
        borderRadius: 14,
        padding: compact ? 18 : 22,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        color: 'var(--ink)',
        textAlign: 'left',
        cursor: 'pointer',
        fontFamily: 'inherit',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 8,
            background: 'var(--bg)',
            border: '1px solid var(--line)',
            color: 'var(--muted)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          {icon}
        </div>
        <div style={{ fontSize: 15, fontWeight: 600 }}>{title}</div>
        <span
          style={{
            marginLeft: 'auto',
            padding: '3px 10px',
            borderRadius: 999,
            background: 'var(--accent-soft)',
            color: 'var(--accent)',
            fontSize: 10,
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
          }}
        >
          {badge}
        </span>
      </div>
      <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: 0, lineHeight: 1.55 }}>{desc}</p>
      {children}
    </button>
  );
}

// ErrorCard (red / amber bordered card) was replaced by RecoveryBlock
// below (MEMORY: feedback_ingestion_be_helpful.md + CLAUDE.md anti-pattern
// "No colored left borders on cards"). The old component has been removed
// in full — keep this note here so the next agent doesn't reintroduce it.

// -----------------------------------------------------------------------
// Proactive ingest recovery block
// -----------------------------------------------------------------------
//
// Replaces the old dead-end ErrorCard shown when a GitHub/OpenAPI ramp
// fails. Surfaces three actions side-by-side, all backed by the
// server's /api/hub/detect/hint response:
//
//   1. Paste direct URL  -> retries /api/hub/detect with the new URL
//   2. Paste contents    -> posts to /api/hub/detect/inline (JSON or YAML)
//   3. Copy prompt       -> one-paste instruction for Claude/Cursor
//
// MEMORY: feedback_ingestion_be_helpful.md — ingest failures must guide
// the user to a fix, never render a dead-end "couldn't find your app"
// card. This component is the gate.
function RecoveryBlock({
  testid,
  kind,
  hint,
  hintLoading,
  pathsTriedFallback,
  recoveryMode,
  setRecoveryMode,
  directSpecUrl,
  setDirectSpecUrl,
  pastedSpec,
  setPastedSpec,
  onDirectSubmit,
  onPasteSubmit,
  onCopyPrompt,
  promptCopied,
  busy,
  error,
}: {
  testid: string;
  kind: 'private' | 'no-openapi' | 'unreachable' | 'repo-not-found';
  hint: IngestHint | null;
  hintLoading: boolean;
  pathsTriedFallback: string[];
  recoveryMode: 'none' | 'direct-url' | 'paste-contents' | 'prompt';
  setRecoveryMode: (
    m: 'none' | 'direct-url' | 'paste-contents' | 'prompt',
  ) => void;
  directSpecUrl: string;
  setDirectSpecUrl: (v: string) => void;
  pastedSpec: string;
  setPastedSpec: (v: string) => void;
  onDirectSubmit: () => void;
  onPasteSubmit: () => void;
  onCopyPrompt: () => void;
  promptCopied: boolean;
  busy: boolean;
  error: string | null;
}) {
  const repoLabel = hint?.repo
    ? `${hint.repo.owner}/${hint.repo.repo}`
    : null;

  // Title + subtitle are authored per kind — the hint.message is a good
  // fallback when the kind doesn't map cleanly.
  let title: string;
  let subtitle: string;
  if (kind === 'no-openapi' && repoLabel) {
    title = `We reached ${repoLabel}, but didn't find an OpenAPI spec`;
    subtitle =
      'Drop an openapi.yaml at the repo root, point us at its URL, or ask Claude to generate one.';
  } else if (kind === 'no-openapi') {
    title = "We couldn't find an OpenAPI spec in that repo";
    subtitle =
      hint?.message ||
      'Drop an openapi.yaml at the repo root, point us at its URL, or ask Claude to generate one.';
  } else if (kind === 'repo-not-found') {
    title = "This repo doesn't exist or isn't public";
    subtitle =
      'Double-check the URL, or skip the repo and paste your spec directly below.';
  } else if (kind === 'private') {
    title = 'This repo looks private';
    subtitle =
      "We can't reach it. Make it public, paste the spec URL, or upload the contents below.";
  } else {
    title = "That doesn't look like a reachable URL";
    subtitle =
      'Paste a GitHub repo URL, a direct openapi.yaml link, or use one of the options below.';
  }

  const pathsTried =
    hint?.paths_tried && hint.paths_tried.length > 0
      ? hint.paths_tried
      : pathsTriedFallback;

  return (
    <div
      data-testid={testid}
      style={{
        marginTop: 16,
        background: 'var(--card)',
        border: '1px solid var(--line)',
        borderRadius: 12,
        padding: 18,
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)', marginBottom: 4 }}>
        {title}
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.55, marginBottom: 14 }}>
        {subtitle}
      </div>

      {pathsTried.length > 0 && (
        <details
          style={{
            background: 'var(--bg)',
            border: '1px solid var(--line)',
            borderRadius: 8,
            padding: '8px 12px',
            fontSize: 12,
            marginBottom: 14,
          }}
        >
          <summary style={{ cursor: 'pointer', color: 'var(--muted)', fontWeight: 500 }}>
            Paths we checked ({pathsTried.length})
          </summary>
          <ul
            style={{
              margin: '8px 0 0',
              padding: '0 0 0 16px',
              color: 'var(--muted)',
              fontSize: 11,
              fontFamily: 'JetBrains Mono, monospace',
              lineHeight: 1.7,
              maxHeight: 180,
              overflowY: 'auto',
            }}
          >
            {pathsTried.map((u) => (
              <li key={u}>
                {u.replace('https://raw.githubusercontent.com/', '').replace('https://', '')}
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* Three action buttons: open one panel at a time. */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: 8,
          marginBottom: recoveryMode === 'none' ? 0 : 14,
        }}
      >
        <RecoveryActionButton
          label="Paste spec URL"
          description="Direct link to openapi.yaml"
          active={recoveryMode === 'direct-url'}
          onClick={() =>
            setRecoveryMode(recoveryMode === 'direct-url' ? 'none' : 'direct-url')
          }
        />
        <RecoveryActionButton
          label="Paste spec contents"
          description="Upload YAML or JSON"
          active={recoveryMode === 'paste-contents'}
          onClick={() =>
            setRecoveryMode(
              recoveryMode === 'paste-contents' ? 'none' : 'paste-contents',
            )
          }
        />
        <RecoveryActionButton
          label="Ask Claude to generate"
          description="Copy a prompt for your agent"
          active={recoveryMode === 'prompt'}
          onClick={() => setRecoveryMode(recoveryMode === 'prompt' ? 'none' : 'prompt')}
        />
      </div>

      {recoveryMode === 'direct-url' && (
        <div>
          <input
            type="text"
            value={directSpecUrl}
            onChange={(e) => setDirectSpecUrl(e.target.value)}
            placeholder="https://example.com/openapi.yaml"
            disabled={busy}
            style={{
              width: '100%',
              padding: '10px 12px',
              border: '1px solid var(--line)',
              borderRadius: 8,
              fontSize: 13,
              marginBottom: 8,
              background: 'var(--bg)',
              color: 'var(--ink)',
            }}
          />
          <button
            type="button"
            disabled={busy || !directSpecUrl.trim()}
            onClick={onDirectSubmit}
            style={{
              padding: '8px 16px',
              background: 'var(--ink)',
              color: 'var(--bg)',
              border: 'none',
              borderRadius: 8,
              fontSize: 12.5,
              fontWeight: 600,
              cursor: busy || !directSpecUrl.trim() ? 'not-allowed' : 'pointer',
              opacity: busy || !directSpecUrl.trim() ? 0.5 : 1,
            }}
          >
            {busy ? 'Detecting…' : 'Detect from this URL'}
          </button>
        </div>
      )}

      {recoveryMode === 'paste-contents' && (
        <div>
          <textarea
            value={pastedSpec}
            onChange={(e) => setPastedSpec(e.target.value)}
            placeholder="# Paste your openapi.yaml / openapi.json here"
            disabled={busy}
            rows={10}
            style={{
              width: '100%',
              padding: '10px 12px',
              border: '1px solid var(--line)',
              borderRadius: 8,
              fontSize: 12,
              marginBottom: 8,
              background: 'var(--bg)',
              color: 'var(--ink)',
              fontFamily: 'JetBrains Mono, monospace',
              resize: 'vertical',
            }}
          />
          <button
            type="button"
            disabled={busy || !pastedSpec.trim()}
            onClick={onPasteSubmit}
            style={{
              padding: '8px 16px',
              background: 'var(--ink)',
              color: 'var(--bg)',
              border: 'none',
              borderRadius: 8,
              fontSize: 12.5,
              fontWeight: 600,
              cursor: busy || !pastedSpec.trim() ? 'not-allowed' : 'pointer',
              opacity: busy || !pastedSpec.trim() ? 0.5 : 1,
            }}
          >
            {busy ? 'Parsing…' : 'Detect from pasted spec'}
          </button>
        </div>
      )}

      {recoveryMode === 'prompt' && (
        <div>
          <div
            style={{
              fontSize: 12,
              color: 'var(--muted)',
              marginBottom: 8,
              lineHeight: 1.55,
            }}
          >
            Paste this into Claude Code / Cursor in your repo. It'll generate an
            openapi.yaml, commit it, and then you can re-run detect above.
          </div>
          <pre
            style={{
              background: 'var(--bg)',
              border: '1px solid var(--line)',
              borderRadius: 8,
              padding: 12,
              fontSize: 11.5,
              fontFamily: 'JetBrains Mono, monospace',
              whiteSpace: 'pre-wrap',
              maxHeight: 260,
              overflowY: 'auto',
              color: 'var(--ink)',
              marginBottom: 8,
            }}
          >
            {hintLoading
              ? 'Loading prompt…'
              : hint?.ready_prompt ||
                "I need to publish my API to Floom. Please add an openapi.yaml at the repo root declaring openapi: 3.0.0, info.title, info.version, servers[], and one entry under paths for each public endpoint. Commit and push."}
          </pre>
          <button
            type="button"
            onClick={onCopyPrompt}
            disabled={!hint?.ready_prompt}
            style={{
              padding: '8px 16px',
              background: promptCopied ? '#10b981' : 'var(--ink)',
              color: 'var(--bg)',
              border: 'none',
              borderRadius: 8,
              fontSize: 12.5,
              fontWeight: 600,
              cursor: hint?.ready_prompt ? 'pointer' : 'not-allowed',
              opacity: hint?.ready_prompt ? 1 : 0.5,
            }}
          >
            {promptCopied ? 'Copied' : 'Copy prompt'}
          </button>
        </div>
      )}

      {error && (
        <div
          style={{
            marginTop: 10,
            padding: '8px 12px',
            background: '#fee2e2',
            color: '#991b1b',
            border: '1px solid #fecaca',
            borderRadius: 8,
            fontSize: 12,
          }}
        >
          {error}
        </div>
      )}

      {hint && (
        <div
          style={{
            marginTop: 14,
            fontSize: 11,
            color: 'var(--muted)',
            lineHeight: 1.55,
          }}
        >
          Agent-callable API:{' '}
          <code style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            POST {hint.upload_url.replace(/^https?:\/\/[^/]+/, '')}
          </code>
          {' · '}
          <code style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            POST {hint.detect_url.replace(/^https?:\/\/[^/]+/, '')}
          </code>
        </div>
      )}
    </div>
  );
}

function RecoveryActionButton({
  label,
  description,
  active,
  onClick,
}: {
  label: string;
  description: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        textAlign: 'left',
        padding: '10px 12px',
        background: active ? 'var(--ink)' : 'var(--bg)',
        color: active ? 'var(--bg)' : 'var(--ink)',
        border: `1px solid ${active ? 'var(--ink)' : 'var(--line)'}`,
        borderRadius: 10,
        cursor: 'pointer',
        transition: 'all 0.15s',
      }}
    >
      <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 2 }}>{label}</div>
      <div
        style={{
          fontSize: 11,
          color: active ? 'rgba(255,255,255,0.7)' : 'var(--muted)',
          lineHeight: 1.4,
        }}
      >
        {description}
      </div>
    </button>
  );
}

function ComingSoonRampModal({
  target,
  onClose,
}: {
  target: 'docker';
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const config = {
    docker: {
      title: 'Docker import (coming soon)',
      copy:
        'Importing apps from Docker is on the v1.1 roadmap. For now, host your app\u2019s openapi.json somewhere public and paste the link.',
    },
  }[target];

  return (
    <div
      role="dialog"
      aria-modal="true"
      data-testid={`coming-soon-ramp-${target}`}
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
          maxWidth: 460,
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
        <h2 style={{ fontSize: 20, fontWeight: 700, margin: '0 0 10px', color: 'var(--ink)' }}>
          {config.title}
        </h2>
        <p style={{ fontSize: 14, color: 'var(--muted)', margin: '0 0 20px', lineHeight: 1.55 }}>
          {config.copy}
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: '8px 18px',
              background: 'var(--accent)',
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}

function SignupToPublishModal({
  onClose,
  onContinue,
  onSignIn,
}: {
  onClose: () => void;
  onContinue: () => void;
  onSignIn: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      data-testid="signup-to-publish-modal"
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
          maxWidth: 460,
          width: '100%',
          boxShadow: '0 20px 60px rgba(0,0,0,0.15)',
        }}
      >
        <h2 style={{ fontSize: 20, fontWeight: 700, margin: '0 0 10px', color: 'var(--ink)' }}>
          Sign up to publish this app
        </h2>
        <p style={{ fontSize: 14, color: 'var(--muted)', margin: '0 0 20px', lineHeight: 1.55 }}>
          Your app is saved. Create a free account to publish it to the store, get a live link,
          and see who runs it.
        </p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={onSignIn}
            data-testid="signup-to-publish-signin"
            style={{
              padding: '10px 18px',
              background: 'transparent',
              color: 'var(--ink)',
              border: '1px solid var(--line)',
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            I already have an account
          </button>
          <button
            type="button"
            onClick={onContinue}
            data-testid="signup-to-publish-continue"
            style={{
              padding: '10px 18px',
              background: 'var(--accent)',
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Create account
          </button>
        </div>
      </div>
    </div>
  );
}

function ShareableUrl({ slug }: { slug: string }) {
  // Publish-success shareable URL with one-click copy. Uses the live
  // origin so the copied value is a full https:// URL that reflects the
  // current env (floom.dev on prod, preview.floom.dev on preview, etc.),
  // not the relative /p/slug that the old banner displayed.
  const [copied, setCopied] = useState(false);
  const fullUrl = `${window.location.origin}/p/${slug}`;
  async function copy() {
    try {
      await navigator.clipboard.writeText(fullUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked in some browsers; noop */
    }
  }
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        background: '#fff',
        border: '1px solid #b5dcc4',
        borderRadius: 8,
        padding: '8px 10px',
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 12.5,
        color: 'var(--ink)',
      }}
    >
      <span data-testid="build-done-url" style={{ userSelect: 'all' }}>{fullUrl}</span>
      <button
        type="button"
        onClick={copy}
        data-testid="build-done-copy"
        style={{
          padding: '4px 10px',
          background: 'var(--accent)',
          color: '#fff',
          border: 'none',
          borderRadius: 6,
          fontSize: 11,
          fontWeight: 600,
          cursor: 'pointer',
          fontFamily: 'inherit',
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

function StepBadge({ active, done, label }: { active: boolean; done: boolean; label: string }) {
  // The CSS fallback on --accent-soft used to be #e9e6ff (purple), which
  // violates Floom's "green accent only" brand rule. Fall back to a green
  // tint so the active step reads clearly, and outline the active pill so
  // it stands out against completed ones.
  return (
    <span
      style={{
        padding: '6px 12px',
        borderRadius: 999,
        fontWeight: 600,
        background: done ? '#e6f4ea' : active ? 'var(--accent-soft, #d7f1e0)' : 'var(--bg)',
        color: done ? '#1a7f37' : active ? 'var(--accent)' : 'var(--muted)',
        border: active ? '1px solid var(--accent)' : '1px solid var(--line)',
      }}
    >
      {label}
    </span>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <label
      style={{
        display: 'block',
        fontSize: 12,
        fontWeight: 600,
        color: 'var(--muted)',
        marginBottom: 6,
        marginTop: 14,
      }}
    >
      {children}
    </label>
  );
}

function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      style={{
        width: '100%',
        padding: '10px 12px',
        border: '1px solid var(--line)',
        borderRadius: 8,
        background: 'var(--card)',
        fontSize: 14,
        color: 'var(--ink)',
        fontFamily: 'inherit',
        boxSizing: 'border-box',
        ...(props.style || {}),
      }}
    />
  );
}

type Visibility = 'public' | 'auth-required' | 'private';

/**
 * Publish-button label for each visibility state. Kept as a pure helper
 * so the button copy and the chooser stay in sync.
 */
function publishButtonLabel(v: Visibility): string {
  if (v === 'private') return 'Publish as Private';
  if (v === 'auth-required') return 'Publish as Signed-in only';
  return 'Publish as Public';
}

/**
 * 3-way visibility chooser for the "Ready to publish" card. Matches the
 * radio-card pattern used by /studio/:slug/access (StudioAppAccessPage)
 * so creators see the same shape in both places.
 *
 * Issue #289: the previous binary toggle silently coerced `auth-required`
 * to `public`, which contradicted the backend (public / auth-required /
 * private all persist fine through /api/hub/ingest).
 */
function VisibilityChooser({
  value,
  onChange,
}: {
  value: Visibility;
  onChange: (next: Visibility) => void;
}) {
  const options: Array<{ id: Visibility; label: string; desc: string }> = [
    {
      id: 'public',
      label: 'Public',
      desc: 'Anyone can run it (shows in the public store)',
    },
    {
      id: 'auth-required',
      label: 'Signed-in users only',
      desc: 'Any Floom user can run it, hidden from store',
    },
    {
      id: 'private',
      label: 'Private (just you)',
      desc: 'Only you (listing hidden, run blocked for others)',
    },
  ];
  return (
    <div
      role="radiogroup"
      aria-label="App visibility"
      data-testid="build-visibility"
      data-value={value}
      style={{
        display: 'grid',
        gap: 8,
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
      }}
    >
      {options.map((opt) => {
        const selected = value === opt.id;
        return (
          <label
            key={opt.id}
            data-testid={`build-visibility-${opt.id}`}
            data-selected={selected ? 'true' : 'false'}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              padding: '12px 14px',
              border: selected ? '1.5px solid var(--accent)' : '1px solid var(--line)',
              background: selected ? 'var(--accent-soft, #e6f4ea)' : 'var(--card)',
              borderRadius: 10,
              cursor: 'pointer',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="radio"
                name="build-visibility"
                value={opt.id}
                checked={selected}
                onChange={() => onChange(opt.id)}
                data-testid={`build-visibility-${opt.id}-input`}
                style={{ accentColor: 'var(--accent)', margin: 0 }}
              />
              <span
                style={{
                  fontSize: 13.5,
                  fontWeight: 600,
                  color: selected ? 'var(--accent)' : 'var(--ink)',
                }}
              >
                {opt.label}
              </span>
            </div>
            <p
              style={{
                margin: 0,
                paddingLeft: 24,
                fontSize: 12,
                color: 'var(--muted)',
                lineHeight: 1.45,
              }}
            >
              {opt.desc}
            </p>
          </label>
        );
      })}
    </div>
  );
}

/** Right-facing chevron for <details> summaries. Rotates via CSS when
 *  the parent details is [open] (handled inline via the details[open]
 *  attribute selector). Small, uses currentColor. */
function Chevron() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
      style={{
        flexShrink: 0,
        transition: 'transform 0.15s ease',
        // The <details>[open] rotation is applied via the parent
        // summary's computed style — but to keep this inline and not
        // touch global CSS, we rely on a wrapper class trick: the
        // summary always renders this chevron pointing right, and
        // browsers visually indicate open state via the summary's
        // native disclosure triangle (which we hide by setting
        // listStyle:'none'). Keeping this simple: no rotation, just
        // the plain icon — state is obvious from the expanded content.
      }}
    >
      <path
        d="M4 2l4 4-4 4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Extract the first sentence from a markdown/plain description.
 *  Strips leading markdown headings and trims. Used for the
 *  "Ready to publish" one-line tagline above the fold — the full
 *  description still lives in the Edit details disclosure. */
function firstSentence(text: string): string {
  if (!text) return '';
  const cleaned = text
    // Drop leading markdown heading lines (# Title) so we don't show
    // the repo name as the description.
    .replace(/^#+\s.*$/gm, '')
    // Collapse whitespace so multi-paragraph READMEs fit one line.
    .replace(/\s+/g, ' ')
    .trim();
  // First sentence ends at . ! ? or the first newline. We already
  // collapsed newlines, so match on . ! ? followed by space or EOL.
  const m = cleaned.match(/^([^.!?]{1,200}[.!?])(\s|$)/);
  if (m) return m[1].trim();
  // Fall back to the first ~140 chars if no sentence boundary is
  // obvious (many READMEs start with a tagline that has no period).
  if (cleaned.length <= 140) return cleaned;
  return cleaned.slice(0, 140).replace(/\s+\S*$/, '') + '…';
}

// Issue #391: translate a publish failure into a user-facing message that
// reflects what actually went wrong on the server, instead of collapsing
// every non-409 error into a generic "Publish failed." toast. We still
// keep the full technical details inside the <details> disclosure below
// the message so a developer can grab the raw error when needed.
function humanizePublishError(err: unknown): string {
  if (err instanceof api.ApiError) {
    // Server gave us structured copy. Prefer its `error` string (set by
    // the hub route) verbatim — the server already knows which message
    // is safe to show a creator (spec_not_found, rate_limited, etc.).
    if (err.message) return err.message;
    if (err.status === 0) {
      return "We couldn't reach the server. Check your connection and try again.";
    }
    if (err.status >= 500) {
      return 'The server returned an error. Try again in a moment.';
    }
    if (err.status === 403) {
      return "You don't have permission to publish this app.";
    }
    return `Publish failed (HTTP ${err.status}).`;
  }
  if (err instanceof Error && err.message) {
    return err.message;
  }
  return 'Publish failed.';
}

// Issues #390 + #391: small inline spinner for the detect and publish
// buttons so an in-flight request has a visible progress affordance.
// Uses the global `floom-spin` keyframe defined in styles/globals.css —
// duplicated from WorkspaceSwitcher's copy so BuildPage stays self-
// contained without cross-component wiring.
function Spinner({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      aria-hidden="true"
      style={{
        flexShrink: 0,
        animation: 'floom-spin 0.9s linear infinite',
      }}
    >
      <path d="M12 3a9 9 0 019 9" />
    </svg>
  );
}

function primaryButton(disabled: boolean): React.CSSProperties {
  return {
    padding: '11px 20px',
    background: 'var(--ink)',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontFamily: 'inherit',
    opacity: disabled ? 0.5 : 1,
  };
}

/* -------------------------- icons -------------------------- */

function GithubIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <use href="#icon-github" />
    </svg>
  );
}

function DockerIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 14h16M6 14V9h2v5M10 14V9h2v5M14 14V9h2v5M8 14V5h2v4M18 14c0 4-3 6-7 6-4 0-6-2-7-4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M10 13h6M10 17h6M10 9h2"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ---------- Waitlist mode panel (launch 2026-04-27) ----------

// Rendered inside BuildPage when DEPLOY_ENABLED=false. Same email-
// capture UX as WaitlistModal / WaitlistPage, scoped to the /studio
// build surface so the user sees *why* there's no publish flow.
// Kept in this file (rather than a fresh component) so it shares the
// same visual density as the rest of the build surface and doesn't
// need a standalone data-testid / story.
const WAITLIST_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function BuildPageWaitlistPanel() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = email.trim();
    if (!WAITLIST_EMAIL_RE.test(trimmed)) {
      setError('Please enter a valid email address.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await api.submitWaitlist({ email: trimmed, source: 'studio-deploy' });
      setSuccess(true);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 429) {
          setError('Too many signups from this network. Try again in an hour.');
        } else if (err.status === 400) {
          setError('That email looked invalid to the server. Double-check and retry.');
        } else {
          setError('Something went wrong on our end. Please try again.');
        }
      } else {
        setError('Network error. Check your connection and try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      data-testid="build-waitlist-panel"
      style={{
        maxWidth: 520,
        margin: '48px auto',
        padding: 32,
        background: 'var(--card)',
        border: '1px solid var(--line)',
        borderRadius: 12,
      }}
    >
      <h1
        style={{
          fontFamily: "'DM Serif Display', Georgia, serif",
          fontSize: 32,
          fontWeight: 400,
          letterSpacing: '-0.02em',
          lineHeight: 1.15,
          margin: '0 0 12px',
          color: 'var(--ink)',
        }}
      >
        Publishing is on the waitlist.
      </h1>
      <p
        style={{
          fontSize: 15,
          lineHeight: 1.6,
          color: 'var(--muted)',
          margin: '0 0 20px',
        }}
      >
        Floom is rolling out Deploy in small batches for the launch week
        of April 27, 2026. Drop your email and we&rsquo;ll let you know
        when your slot opens. In the meantime the featured apps are free
        to run — no signup required.
      </p>
      {success ? (
        <div
          data-testid="build-waitlist-success"
          style={{
            padding: 16,
            background: 'var(--bg)',
            border: '1px solid var(--line)',
            borderRadius: 8,
            fontSize: 14,
            lineHeight: 1.5,
            color: 'var(--ink)',
          }}
        >
          You&rsquo;re on the list. We&rsquo;ll email you when a slot opens.
          <div style={{ marginTop: 12 }}>
            <Link
              to="/apps"
              style={{
                fontSize: 13,
                color: 'var(--ink)',
                textDecoration: 'underline',
              }}
            >
              Browse the store →
            </Link>
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit}>
          <label
            htmlFor="build-waitlist-email"
            style={{
              display: 'block',
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--muted)',
              marginBottom: 6,
            }}
          >
            Email
          </label>
          <input
            id="build-waitlist-email"
            type="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (error) setError(null);
            }}
            placeholder="you@example.com"
            autoComplete="email"
            spellCheck={false}
            disabled={submitting}
            data-testid="build-waitlist-email"
            aria-label="Email address"
            style={{
              width: '100%',
              padding: 12,
              border: `1px solid ${error ? 'var(--danger, #e5484d)' : 'var(--line)'}`,
              borderRadius: 8,
              background: 'var(--bg)',
              color: 'var(--ink)',
              fontSize: 14,
              boxSizing: 'border-box',
              marginBottom: error ? 6 : 14,
            }}
          />
          {error && (
            <div
              data-testid="build-waitlist-error"
              role="alert"
              style={{
                fontSize: 12,
                color: 'var(--danger, #e5484d)',
                marginBottom: 10,
              }}
            >
              {error}
            </div>
          )}
          <button
            type="submit"
            disabled={submitting}
            data-testid="build-waitlist-submit"
            style={{
              width: '100%',
              padding: '12px 16px',
              border: 'none',
              borderRadius: 8,
              background: 'var(--ink)',
              color: 'var(--card)',
              fontSize: 14,
              fontWeight: 600,
              cursor: submitting ? 'default' : 'pointer',
              opacity: submitting ? 0.7 : 1,
            }}
          >
            {submitting ? 'Joining…' : 'Join waitlist'}
          </button>
        </form>
      )}
    </div>
  );
}
