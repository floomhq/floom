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
//   - Breadcrumb row above the frame is small + quiet (Apps / name).
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
import { ShareModal } from '../components/share/ShareModal';
import {
  ClaudeSkillModal,
  ClaudeSkillIcon,
} from '../components/share/ClaudeSkillModal';
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
// Launch-hardening 2026-04-23: the 3 hero demo apps (lead-scorer,
// competitor-analyzer, resume-screener) get a richer per-slug prefill
// so the public landing experience on floom.dev isn't an empty form.
// Non-hero apps fall through to the generic samplePrefill() above.
import { getLaunchDemoExampleTextInputs } from '../lib/app-examples';

// Map of known app slugs to GitHub repo URLs. Only slugs whose example
// directory lives in examples/ are linked; stub-only apps (floom.yaml with
// no server code) were removed in the 2026-04-17 bloat cut.
const GITHUB_REPOS: Record<string, string> = {
  'blast-radius': 'https://github.com/floomhq/floom/tree/main/examples/blast-radius',
  'claude-wrapped': 'https://github.com/floomhq/floom/tree/main/examples/claude-wrapped',
  'dep-check': 'https://github.com/floomhq/floom/tree/main/examples/dep-check',
  'hook-stats': 'https://github.com/floomhq/floom/tree/main/examples/hook-stats',
  'session-recall': 'https://github.com/floomhq/floom/tree/main/examples/session-recall',
  'ig-nano-scout': 'https://github.com/floomhq/floom/tree/main/examples/ig-nano-scout',
};

// v23 PR-D (2026-04-26): per-slug hero subhead override for the 3 launch
// demos. The wireframe ships a sales-tone one-liner that explains what the
// app does + what to expect, instead of the generic markdown-stripped
// `app.description`. Federico-locked copy. Non-launch slugs fall through
// to the existing `headerDescription` derivation (description-as-subhead).
const HERO_SUBHEAD: Record<string, string> = {
  'competitor-lens':
    'Paste 2 URLs (yours + competitor). Get the positioning, pricing, and angle diff in under 5 seconds.',
  'ai-readiness-audit':
    'Paste a company URL. Get a readiness score, 3 risks, 3 opportunities, and one concrete next step.',
  'pitch-coach':
    'Paste a 20-500 char startup pitch. Get 3 direct critiques, 3 rewrites by angle, and a one-line TL;DR.',
};

export function AppPermalinkPage() {
  const { slug } = useParams<{ slug: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const runIdFromUrl = searchParams.get('run');
  const rerunIdFromUrl = searchParams.get('rerun');
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
  // #640: Notion-style Share modal. The hero Share button opens this
  // dialog instead of falling straight through to navigator.share /
  // clipboard.writeText. `shareModalUrl` is resolved at click time so it
  // reflects the currently-selected run (if any). The previous one-shot
  // "Link copied" toast lived in `shareToast` — the modal owns that
  // affordance now (copy button + inline "Copied" state), so the toast
  // was removed in the same change.
  const [shareModalOpen, setShareModalOpen] = useState(false);
  const [shareModalUrl, setShareModalUrl] = useState<string>('');
  // PR #761 follow-up: front-door for the /p/:slug/skill.md backend
  // route. The hero CTA "Install as Claude Skill" opens this modal,
  // which shows the curl one-liner + an example Claude Code prompt.
  const [claudeSkillModalOpen, setClaudeSkillModalOpen] = useState(false);

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
  const [rerunInputs, setRerunInputs] = useState<Record<string, unknown> | null>(null);
  const [rerunLoading, setRerunLoading] = useState<boolean>(!!rerunIdFromUrl && !runIdFromUrl);
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

  useEffect(() => {
    if (!slug || !rerunIdFromUrl || runIdFromUrl) {
      setRerunInputs(null);
      setRerunLoading(false);
      return;
    }
    let cancelled = false;
    setRerunLoading(true);
    getRun(rerunIdFromUrl)
      .then((run) => {
        if (cancelled) return;
        if (run.app_slug && run.app_slug !== slug) {
          setRerunInputs(null);
          setSearchParams(
            (prev) => {
              const next = new URLSearchParams(prev);
              next.delete('rerun');
              return next;
            },
            { replace: true },
          );
          return;
        }
        if (run.inputs && typeof run.inputs === 'object' && !Array.isArray(run.inputs)) {
          setRerunInputs(run.inputs as Record<string, unknown>);
          return;
        }
        setRerunInputs({});
      })
      .catch(() => {
        if (!cancelled) setRerunInputs(null);
      })
      .finally(() => {
        if (!cancelled) setRerunLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug, rerunIdFromUrl, runIdFromUrl, setSearchParams]);

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
    if (runIdFromUrl || initialRun || initialRunLoading || rerunLoading) return;
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
  }, [app, activeTab, runIdFromUrl, initialRun, initialRunLoading, rerunLoading]);

  const initialSurfaceLoading = initialRunLoading || rerunLoading;

  // Single-line plain-text description for the compact header. Strips
  // markdown syntax + collapses whitespace so a multi-line or markdown
  // description still renders as one clean line above the tabs. The full
  // rich description still renders (markdown-formatted) in the About tab.
  //
  // v23 PR-D (2026-04-26): the 3 launch demos override this with a
  // sales-tone one-liner from HERO_SUBHEAD (Federico-locked). Everything
  // else falls through to the markdown-stripped `app.description`.
  const headerDescription = useMemo<string>(() => {
    if (app?.slug && HERO_SUBHEAD[app.slug]) return HERO_SUBHEAD[app.slug];
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
  }, [app?.description, app?.slug]);

  // Compute sample input pre-fill for the first input of each action.
  // Only fires on first visit (no shared-run ?run=<id>) so that a direct
  // link to a completed run stays faithful to the inputs that actually
  // produced it. We hydrate ALL inputs (so RunSurface's buildInitialInputs
  // doesn't discard our value in favour of '' for the unprefilled ones),
  // but only assign real samples to inputs whose name/type we recognise.
  const samplePrefillInputs = useMemo<Record<string, unknown> | null>(() => {
    if (!app) return null;
    if (runIdFromUrl || rerunIdFromUrl) return null; // respect shared-run links
    const firstActionKey = Object.keys(app.manifest.actions)[0];
    const action = firstActionKey ? app.manifest.actions[firstActionKey] : undefined;
    if (!action || action.inputs.length === 0) return null;
    // Launch demo (lead-scorer / competitor-analyzer / resume-screener):
    // prefill EVERY text input the manifest declares. File inputs stay
    // empty so the user either drops their own bytes or clicks the
    // per-control "Load example" button rendered by InputField. Doing
    // this here (vs inside RunSurface) keeps shared-run links faithful
    // — we already gate on `runIdFromUrl` above.
    const demoText = getLaunchDemoExampleTextInputs(app.slug);
    if (demoText) {
      const prefilled: Record<string, unknown> = {};
      for (const spec of action.inputs) {
        if (spec.name in demoText) {
          prefilled[spec.name] = demoText[spec.name];
        }
      }
      if (Object.keys(prefilled).length > 0) return prefilled;
    }
    // Generic fallback for every other app: prefill ONLY the first
    // input (the one the user would click into first). Everything else
    // uses its existing default/empty so the first-run form stays
    // visually "clean" — one planted example, not five.
    const first = action.inputs[0];
    const sample = samplePrefill(first);
    if (sample == null) return null;
    return { [first.name]: sample };
  }, [app, runIdFromUrl, rerunIdFromUrl]);

  // First declared input on the primary (or first-declared) action,
  // surfaced to the Claude Skill modal so the example prompt reads
  // "Run lead-scorer with company_url=…" instead of a placeholder.
  // Returns null when the manifest declares no inputs — the modal
  // collapses to a generic "Run <slug>" example in that case.
  const claudeSkillFirstInput = useMemo<string | null>(() => {
    if (!app) return null;
    const actions = app.manifest?.actions ?? {};
    const primary =
      app.manifest?.primary_action && actions[app.manifest.primary_action]
        ? app.manifest.primary_action
        : Object.keys(actions)[0];
    if (!primary) return null;
    const action = actions[primary];
    const first = action?.inputs?.[0];
    return first?.name ?? null;
  }, [app]);

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
    // Title separator: use a middle dot to match every other page on the
    // site (Pricing · Floom, Docs · Floom, etc.). We were shipping a pipe
    // here, which read as inconsistent across tabs and share cards.
    const docTitle = `${app.name} · Floom`;
    document.title = docTitle;
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
    setMeta('og:title', docTitle, true);
    setMeta('og:description', app.description, true);
    setMeta('og:url', `${window.location.origin}/p/${app.slug}`, true);
    setMeta('og:type', 'website', true);
    // Canonical URL — every /p/:slug permalink on floom.dev should self-
    // reference, not inherit the landing page's canonical (issue #172).
    const canon = document.head.querySelector('link[rel="canonical"]') as HTMLLinkElement | null;
    if (canon) canon.setAttribute('href', `https://floom.dev/p/${app.slug}`);
    // Per-app dynamic OG card (served by /og/:slug.svg on the same origin).
    setMeta('og:image', `${window.location.origin}/og/${app.slug}.svg`, true);
    setMeta('twitter:image', `${window.location.origin}/og/${app.slug}.svg`);
    setMeta('twitter:title', docTitle);
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
  // F2 (2026-04-28): by-handle pill removed from hero default view
  // (already exposed in the About tab). Memo retained for parity if
  // we re-introduce the pill later. Underscore prefix = intentional
  // unused per TS6133.
  const _heroHandle = useMemo(() => {
    if (!app) return null;
    const raw =
      (app.creator_handle && app.creator_handle.trim()) ||
      (app.author_display && app.author_display.replace(/^@/, '').trim()) ||
      (app.author && app.author.trim()) ||
      null;
    if (!raw) return null;
    return raw.length > 22 ? `${raw.slice(0, 20)}…` : raw;
  }, [app]);
  void _heroHandle;

  /** Truthy manifest / hub fields as compact chips (Issue #284). */
  const capabilityChips = useMemo(() => {
    if (!app) return [] as Array<{ key: string; label: string }>;
    const out: Array<{ key: string; label: string }> = [];
    const seen = new Set<string>();
    const add = (key: string, label: string) => {
      const t = label.trim();
      if (!t || seen.has(t)) return;
      seen.add(t);
      out.push({ key, label: t });
    };
    const titleCaseWords = (s: string) =>
      s
        .replace(/[_-]+/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .map((w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase())
        .join(' ');
    const m = app.manifest as unknown as Record<string, unknown>;
    const caps = m?.capabilities;
    if (caps && typeof caps === 'object' && !Array.isArray(caps)) {
      for (const [k, v] of Object.entries(caps as Record<string, unknown>)) {
        if (v === true) {
          if (k === 'web_search' || k === 'network' || k === 'web') {
            add(`cap-${k}`, 'Web search');
          } else {
            add(`cap-${k}`, titleCaseWords(k));
          }
        } else if (typeof v === 'string' && v.trim()) {
          add(`cap-${k}`, `${titleCaseWords(k)}: ${v.trim()}`);
        } else if (typeof v === 'number' && v !== 0) {
          add(`cap-${k}`, `${titleCaseWords(k)}: ${v}`);
        }
      }
    }
    const rt = (app.runtime && app.runtime.trim()) || (typeof m.runtime === 'string' ? m.runtime.trim() : '');
    if (rt) {
      add('runtime', `Runtime: ${rt}`);
    }
    for (const s of app.manifest.secrets_needed ?? []) {
      if (typeof s === 'string' && s.trim()) {
        add(`sec-${s}`, `App creator secrets: ${s.trim()}`);
      }
    }
    if (app.is_async) add('async', 'Async jobs');
    if (app.upstream_host?.trim()) {
      add('upstream', `API: ${app.upstream_host.trim()}`);
    }
    if (app.renderer) add('custom-renderer', 'Custom output UI');
    return out;
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
        style={{ padding: '20px 24px 80px', maxWidth: 1040, margin: '0 auto' }}
        data-testid="permalink-page"
      >
        {/* v17 breadcrumb: quiet Apps / app-name. Lives OUTSIDE the
            frame card. */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
            marginBottom: 14,
            fontSize: 12.5,
            color: 'var(--muted)',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              flexWrap: 'wrap',
            }}
          >
            <Link to="/apps" style={{ color: 'var(--muted)', textDecoration: 'none' }}>
              Apps
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

        {/* G4 + G6 (2026-04-28): rounded white card wrapping hero+tabs+body
            with proper padding, border-radius, soft shadow, and a LOCKED
            width (1040px on <main> above) so EVERY tab body inherits the
            same width. Federico: "the white background has no proper
            padding; the background of the page should at least have a
            radius on the white container" + "the white container should
            stick to a certain width, and it does not matter whether I'm
            on a certain tab; this is a bit confusing". */}
        <div
          data-testid="permalink-card"
          style={{
            background: 'var(--card)',
            border: '1px solid var(--line)',
            borderRadius: 18,
            overflow: 'hidden',
            boxShadow: '0 1px 2px rgba(22,21,18,0.04), 0 4px 24px rgba(22,21,18,0.05)',
          }}
        >

          {/* F2 (2026-04-28): /p/:slug top chrome cleanup. */}
          <section
            data-testid="permalink-hero"
            className="permalink-hero-row"
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 14,
              padding: '24px 28px 20px',
              flexWrap: 'wrap',
            }}
          >
            <div
              style={{
                width: 52,
                height: 52,
                borderRadius: 14,
                background: 'var(--bg)',
                border: '1px solid var(--line)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--accent)',
                flexShrink: 0,
              }}
            >
              <AppIcon slug={app.slug} size={26} />
            </div>
            <div className="permalink-hero-title" style={{ flex: 1, minWidth: 0 }}>
              <h1
                style={{
                  fontSize: 24,
                  fontWeight: 700,
                  color: 'var(--ink)',
                  margin: 0,
                  lineHeight: 1.18,
                  letterSpacing: '-0.02em',
                }}
              >
                {app.name}
              </h1>
              {headerDescription && (
                <p
                  data-testid="hero-description"
                  title={headerDescription}
                  style={{
                    fontSize: 13.5,
                    color: 'var(--muted)',
                    margin: '4px 0 0',
                    lineHeight: 1.45,
                    maxWidth: 640,
                  }}
                >
                  {headerDescription}
                </p>
              )}
              {/* G5 (2026-04-28): unified single-row pills. Federico:
                  "they should be next to each other and not in two rows,
                  because this takes up much space". Previously TWO pill
                  rows (version-meta + capability-chips) stacked to 2-3
                  rows. Now ONE row, no-wrap, hides scrollbar; capability
                  chips merged inline so [research][v0.1.0 stable]
                  [Runtime: python] all sit on one line. */}
              <div
                data-testid="hero-version-meta"
                className="permalink-hero-version-meta"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  flexWrap: 'nowrap',
                  marginTop: 10,
                  overflowX: 'auto',
                  scrollbarWidth: 'none',
                }}
              >
                {app.runs_7d != null && app.runs_7d > 0 && (
                  <span style={{ fontSize: 11, padding: '3px 9px', borderRadius: 999, border: '1px solid var(--line)', color: 'var(--muted)', background: 'var(--bg)', whiteSpace: 'nowrap', flexShrink: 0 }}>
                    {app.runs_7d.toLocaleString()} runs · 7d
                  </span>
                )}
                {app.category && (
                  <span style={{ fontSize: 11, padding: '3px 9px', borderRadius: 999, border: '1px solid var(--line)', color: 'var(--muted)', background: 'var(--bg)', whiteSpace: 'nowrap', flexShrink: 0 }}>
                    {app.category}
                  </span>
                )}
                {summary && summary.count > 0 && (
                  <span style={{ fontSize: 11, padding: '3px 9px', borderRadius: 999, border: '1px solid var(--line)', color: 'var(--muted)', background: 'var(--bg)', display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap', flexShrink: 0 }}>
                    <StarsRow value={summary.avg} size={11} />
                    {summary.avg.toFixed(1)}
                  </span>
                )}
                <span data-testid="hero-version" style={{ fontSize: 11, padding: '3px 9px', borderRadius: 999, border: '1px solid var(--line)', color: 'var(--muted)', background: 'var(--bg)', fontFamily: 'JetBrains Mono, ui-monospace, monospace', whiteSpace: 'nowrap', flexShrink: 0 }}>
                  v{app.version ?? '0.1.0'} · {app.version_status ?? 'stable'}
                </span>
                {/* G5: capability chips merged inline — same row, same
                    pill style, no wrap. */}
                {capabilityChips.map((c) => (
                  <span
                    key={c.key}
                    style={{
                      fontSize: 11,
                      fontWeight: 500,
                      padding: '3px 9px',
                      borderRadius: 999,
                      border: '1px solid var(--line)',
                      color: 'var(--muted)',
                      background: 'var(--bg)',
                      letterSpacing: '0.02em',
                      whiteSpace: 'nowrap',
                      flexShrink: 0,
                    }}
                  >
                    {c.label}
                  </span>
                ))}
              </div>
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
              {/* v26 Install in workspace CTA */}
              {session ? (
                <button
                  type="button"
                  disabled
                  title="Install coming soon"
                  data-testid="cta-install-workspace"
                  style={{
                    padding: '8px 14px',
                    border: '1px solid var(--ink)',
                    borderRadius: 10,
                    fontSize: 12.5,
                    fontWeight: 600,
                    color: '#fff',
                    background: 'var(--ink)',
                    cursor: 'not-allowed',
                    fontFamily: 'inherit',
                    opacity: 0.5,
                  }}
                >
                  + Install in workspace
                </button>
              ) : (
                <a
                  href="/login"
                  data-testid="cta-install-anon"
                  style={{
                    padding: '8px 14px',
                    border: '1px solid var(--ink)',
                    borderRadius: 10,
                    fontSize: 12.5,
                    fontWeight: 600,
                    color: '#fff',
                    background: 'var(--ink)',
                    textDecoration: 'none',
                    fontFamily: 'inherit',
                    display: 'inline-flex',
                    alignItems: 'center',
                  }}
                >
                  Sign in to install
                </a>
              )}
              {/* PR #761 front-door: "Install as Claude Skill" trigger
                  for the /p/:slug/skill.md backend route. Same chrome as
                  the Share button so the two CTAs read as a pair (no new
                  colours, no gradients). Sits to the LEFT of Share so
                  the primary social affordance (Share) keeps its
                  rightmost position in the hero action cluster. */}
              <button
                type="button"
                data-testid="cta-install-claude-skill"
                aria-label="Install as Skill"
                onClick={() => setClaudeSkillModalOpen(true)}
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
                <ClaudeSkillIcon /> Install as Skill
              </button>
              <button
                type="button"
                data-testid="cta-share"
                aria-label="Share link"
                onClick={() => {
                  // #640: open the Notion-style Share modal. We still pre-
                  // resolve the best URL to seed the "Private signed link"
                  // field so the modal is useful immediately: if the user
                  // has a run selected, flip it to public first (same
                  // shareRun() call the old handler used) and show the
                  // /r/:id permalink. Otherwise fall back to the current
                  // /p/:slug URL. Any failure just falls back to the page
                  // URL — the modal still opens, never a dead-end.
                  const resolve = async () => {
                    try {
                      const currentUrl = new URL(window.location.href);
                      const currentRunId = currentUrl.searchParams.get('run');
                      if (!currentRunId) {
                        setShareModalUrl(currentUrl.toString());
                        setShareModalOpen(true);
                        return;
                      }
                      try {
                        await shareRun(currentRunId);
                        setShareModalUrl(
                          `${window.location.origin}${buildPublicRunPath(currentRunId)}`,
                        );
                      } catch {
                        currentUrl.searchParams.delete('run');
                        setShareModalUrl(currentUrl.toString());
                      }
                      setShareModalOpen(true);
                    } catch {
                      setShareModalUrl(window.location.href);
                      setShareModalOpen(true);
                    }
                  };
                  void resolve();
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

          {/* Top tab bar (#626, 2026-04-24): moved About / Install / Source
              from the bottom chip row to an underlined tab bar directly
              below the hero. Run stays the default (no tab rendered) so
              the Run surface fills the frame. Clicking a secondary tab
              swaps the content panel below. Deviates from the v17
              wireframe's bottom chip row — the wireframe keeps these as
              chips at the bottom, but Federico's review called for
              TABS-at-top placement (see PR body). Behaviour is
              unchanged: clicking each tab swaps the content panel, URL
              updates via ?tab=, test-ids preserved. */}
          <div
            role="tablist"
            aria-label="App content"
            data-testid="permalink-tabs"
            style={{
              display: 'flex',
              alignItems: 'stretch',
              flexWrap: 'wrap',
              gap: 0,
              padding: '0 28px',
              borderBottom: '1px solid var(--line)',
              background: 'transparent',
            }}
          >
            {([
              { id: 'run' as PTab, label: 'Run' },
              { id: 'about' as PTab, label: 'About' },
              { id: 'install' as PTab, label: 'Install' },
              { id: 'source' as PTab, label: 'Source' },
            ]).map((t) => {
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
                    padding: '12px 16px',
                    fontSize: 13,
                    fontWeight: isOn ? 600 : 500,
                    border: 'none',
                    background: 'transparent',
                    color: isOn ? 'var(--ink)' : 'var(--muted)',
                    borderBottom: isOn
                      ? '2px solid var(--accent)'
                      : '2px solid transparent',
                    marginBottom: -1,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    whiteSpace: 'nowrap',
                    transition: 'color .12s, border-color .12s',
                  }}
                >
                  {t.label}
                </button>
              );
            })}
          </div>

          {/* Frame body: swappable by ?tab= (Run / About / Install / Source).
              G4: proper inner padding + transparent bg (the outer
              permalink-card provides the white surface). */}
          <div
            className="app-page-body"
            style={{
              padding: '28px 32px 36px',
              background: 'transparent',
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
            {initialSurfaceLoading ? (
              <div
                data-testid="shared-run-loading"
                style={{ color: 'var(--muted)', fontSize: 13, padding: 24, textAlign: 'center' }}
              >
                {runIdFromUrl ? 'Loading shared run...' : 'Loading previous inputs...'}
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
                  initialInputs={rerunInputs ?? samplePrefillInputs ?? undefined}
                  onResetInitialRun={handleResetInitialRun}
                  onResult={handleRunResult}
                />
                {/* v26 3-card footer */}
                <div
                  data-testid="ap-foot-grid"
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(3, 1fr)',
                    gap: 14,
                    marginTop: 32,
                    paddingTop: 24,
                    borderTop: '1px solid var(--line)',
                  }}
                  className="ap-foot-grid-responsive"
                >
                  {([
                    {
                      id: 'about' as const,
                      title: 'About this app',
                      desc: 'How it works, who built it, license, changelog. Read the full README.',
                      cta: 'Read about',
                    },
                    {
                      id: 'install' as const,
                      title: 'Install in Claude / Cursor / API',
                      desc: 'One command for Claude Desktop. A single endpoint for Cursor. Plain HTTP for everything else.',
                      cta: 'Install',
                    },
                    {
                      id: 'source' as const,
                      title: 'Source on GitHub',
                      desc: githubRepo
                        ? `${githubRepo.replace('https://github.com/', '')} · ${app.manifest?.license?.trim() ?? 'MIT'}`
                        : 'OpenAPI spec, floom manifest, and self-host instructions.',
                      cta: 'View source',
                    },
                  ]).map((card) => (
                    <button
                      key={card.id}
                      type="button"
                      onClick={() => {
                        setActiveTab(card.id);
                        setSearchParams((prev) => {
                          const next = new URLSearchParams(prev);
                          next.set('tab', card.id);
                          return next;
                        }, { replace: true });
                      }}
                      style={{
                        background: 'var(--card)',
                        border: '1px solid var(--line)',
                        borderRadius: 12,
                        padding: '18px 20px',
                        textAlign: 'left',
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 6,
                      }}
                    >
                      <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ink)' }}>
                        {card.title}
                      </div>
                      <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5, flex: 1 }}>
                        {card.desc}
                      </div>
                      <div style={{ fontSize: 12.5, color: 'var(--accent)', fontWeight: 600, marginTop: 4 }}>
                        {card.cta} &rarr;
                      </div>
                    </button>
                  ))}
                </div>
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

        {/* About tab. v26 parity: two-column layout (main prose + aside meta panel). */}
        {activeTab === 'about' && (
        <>
        {/* v26 two-column about body */}
        <div
          data-testid="about-body"
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) 280px',
            gap: 32,
          }}
          className="about-body-grid"
        >
          {/* Left: prose + how-it-works + reviews */}
          <main>
            {/* How it works strip (inline in left column) */}
            {howItWorks.length > 0 && (
              <section
                data-testid="how-it-works"
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
                  gap: 12,
                  marginBottom: 28,
                }}
              >
                {howItWorks.map((step, idx) => (
                  <div
                    key={idx}
                    style={{
                      background: 'var(--bg)',
                      border: '1px solid var(--line)',
                      borderRadius: 10,
                      padding: 16,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 8,
                    }}
                  >
                    <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                      Step {idx + 1}
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>{step.label}</div>
                    {step.description && (
                      <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.55 }}>{step.description}</div>
                    )}
                  </div>
                ))}
              </section>
            )}

            {/* About prose — suppress if description equals hero subhead (short utility apps) */}
            {(() => {
              const trimmed = (app.description ?? '').trim();
              const isDuplicateOfHero =
                trimmed.length > 0 &&
                trimmed === headerDescription &&
                trimmed.length <= 160;
              const showAboutProse = !!trimmed && !isDuplicateOfHero;
              const hasReviews = summary && summary.count > 0;
              if (!showAboutProse && !hasReviews) {
                return (
                  <section style={{ paddingBottom: 24, marginBottom: 24, borderBottom: '1px solid var(--line)' }}>
                    <AppReviews slug={app.slug} />
                  </section>
                );
              }
              return (
                <section style={{ paddingBottom: 24, marginBottom: 24, borderBottom: '1px solid var(--line)' }}>
                  {showAboutProse && (
                    <>
                      <h2 style={{ fontSize: 18, fontWeight: 600, margin: '0 0 14px', color: 'var(--ink)', letterSpacing: '-0.01em' }}>
                        About this app
                      </h2>
                      <DescriptionMarkdown
                        description={app.description!}
                        testId="about-description"
                        style={{ fontSize: 14, color: 'var(--text-2, var(--muted))', margin: 0, lineHeight: 1.65, marginBottom: 24 }}
                      />
                    </>
                  )}
                  {hasReviews && <RatingsWidget summary={summary} />}
                  <AppReviews slug={app.slug} />
                </section>
              );
            })()}
          </main>

          {/* Right: aside meta panels */}
          <aside data-testid="about-aside">
            {/* App meta panel */}
            <div
              data-testid="details-card"
              style={{
                background: 'var(--bg)',
                border: '1px solid var(--line)',
                borderRadius: 12,
                padding: '16px 18px',
                marginBottom: 14,
              }}
            >
              <h4 style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10.5, color: 'var(--muted)', letterSpacing: '0.08em', textTransform: 'uppercase', fontWeight: 600, margin: '0 0 10px' }}>
                App meta
              </h4>
              <AboutMetaRow label="Slug" value={<code style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11.5 }}>{app.slug}</code>} />
              {app.version && <AboutMetaRow label="Version" value={<code style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11.5 }}>v{app.version}</code>} />}
              {app.manifest?.license?.trim() && (
                <AboutMetaRow
                  label="License"
                  value={
                    githubRepo ? (
                      <a href={`${githubRepo}/blob/main/LICENSE`} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', textDecoration: 'none', fontFamily: 'JetBrains Mono, monospace', fontSize: 11.5 }}>
                        {app.manifest.license.trim()}
                      </a>
                    ) : (
                      <code style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11.5 }}>{app.manifest.license.trim()}</code>
                    )
                  }
                />
              )}
              {app.runtime && (
                <AboutMetaRow label="Runtime" value={<code style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11.5 }}>{app.runtime}</code>} />
              )}
              {app.category && <AboutMetaRow label="Category" value={app.category} />}
              {createdByLabel && <AboutMetaRow label="Created by" value={createdByLabel} />}
            </div>

            {/* Stats panel */}
            {(summary || app.runs_7d != null) && (
              <div
                data-testid="about-stats"
                style={{
                  background: 'var(--bg)',
                  border: '1px solid var(--line)',
                  borderRadius: 12,
                  padding: '16px 18px',
                }}
              >
                <h4 style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10.5, color: 'var(--muted)', letterSpacing: '0.08em', textTransform: 'uppercase', fontWeight: 600, margin: '0 0 10px' }}>
                  Stats
                </h4>
                {app.runs_7d != null && app.runs_7d > 0 && (
                  <AboutMetaRow label="Runs (7d)" value={<code style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11.5 }}>{app.runs_7d.toLocaleString()}</code>} />
                )}
                {summary && summary.count > 0 && (
                  <>
                    <AboutMetaRow label="Ratings" value={<code style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11.5 }}>{summary.count}</code>} />
                    <AboutMetaRow label="Avg rating" value={<code style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11.5, color: 'var(--accent)' }}>{summary.avg.toFixed(1)}/5</code>} />
                  </>
                )}
              </div>
            )}
          </aside>
        </div>
        </>
        )}

        {/* Install tab. v26 parity: 3 install cards — Claude Desktop/Code,
            Cursor/MCP, cURL. Code blocks use warm-dark --code background. */}
        {activeTab === 'install' && (
        <section id="connectors" data-testid="connectors">
          <div
            style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 880 }}
            data-testid="connectors-grid"
          >
            <InstallCard
              testId="connector-claude"
              title="Claude Desktop / Claude Code"
              desc={`Adds ${app.name} as a Skill. Run via natural language. MCP-installable via Skill add command.`}
              snippetValue={`claude skill add ${window.location.origin}/p/${app.slug}`}
              copyLabel="Copy command"
            />
            <InstallCard
              testId="connector-cursor"
              title="Cursor / ChatGPT / any MCP client"
              desc="Add to your MCP config. The endpoint is the same; only the config file differs per client."
              snippetValue={mcpEndpoint}
              copyLabel="Copy MCP URL"
            />
            <InstallCard
              testId="connector-curl"
              title="cURL / JSON API"
              desc="Bearer-token auth with an Agent token. Same endpoint as the public page, just hit it programmatically."
              snippetValue={`curl -X POST ${window.location.origin}/api/${app.slug}/run \\\n  -H "Authorization: Bearer floom_agent_••••••" \\\n  -d '{}'`}
              copyLabel="Copy cURL"
              copySnippet={`curl -X POST ${window.location.origin}/api/${app.slug}/run \\\n  -H "Authorization: Bearer YOUR_TOKEN" \\\n  -d '{}'`}
            />
          </div>
          <p
            data-testid="connectors-more"
            style={{ marginTop: 10, fontSize: 12.5, color: 'var(--muted)', textAlign: 'center' }}
          >
            Need help?{' '}
            <a
              href="/docs"
              data-testid="connectors-docs"
              style={{ color: 'var(--accent)', fontWeight: 600, textDecoration: 'none' }}
            >
              Read the full install guide &rarr;
            </a>
          </p>
        </section>
        )}

        {/* Source tab. v26 parity: repo card + spec card (2-col grid) + self-host card.
            G10 (2026-04-28): when no source_url, hide the Repository card
            entirely (no blank-box chrome, no slug echo). Grid collapses to
            single column so the Spec card spans full width. A concise inline
            note above the grid carries the "source not linked" context. */}
        {activeTab === 'source' && (
          <section data-testid="tab-content-source">
            {!githubRepo && (
              <p
                data-testid="source-no-repo-note"
                style={{
                  fontSize: 12.5,
                  color: 'var(--muted)',
                  margin: '0 0 14px',
                  lineHeight: 1.55,
                }}
              >
                Source not publicly linked. Check with the app creator.
              </p>
            )}
            {/* 2-column grid: repo + spec (or single-column when no repo) */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: githubRepo ? '1fr 1fr' : '1fr',
                gap: 14,
                marginBottom: 14,
              }}
              className="source-cards-grid"
            >
              {/* Repo card — hidden when no github source linked (G10). */}
              {githubRepo && (
                <div
                  data-testid="source-repo-card"
                  style={{
                    background: 'var(--card)',
                    border: '1px solid var(--line)',
                    borderRadius: 12,
                    padding: '18px 20px',
                  }}
                >
                  <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10.5, color: 'var(--muted)', letterSpacing: '0.08em', textTransform: 'uppercase', fontWeight: 600, marginBottom: 8 }}>
                    Repository
                  </div>
                  <h3 style={{ fontSize: 14, fontWeight: 600, margin: '0 0 8px', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <GithubIcon /> {githubRepo.replace('https://github.com/', '')}
                  </h3>
                  {app.manifest?.license && (
                    <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 14px', lineHeight: 1.5 }}>
                      {app.manifest.license} licensed
                      {app.version ? ` · v${app.version}` : ''}
                    </p>
                  )}
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <a
                      href={githubRepo}
                      target="_blank"
                      rel="noreferrer"
                      style={{
                        fontSize: 12.5,
                        fontWeight: 600,
                        padding: '6px 12px',
                        border: '1px solid var(--line)',
                        borderRadius: 8,
                        color: 'var(--ink)',
                        textDecoration: 'none',
                        background: 'var(--bg)',
                      }}
                    >
                      View on GitHub &rarr;
                    </a>
                  </div>
                </div>
              )}

              {/* Spec card */}
              <div
                data-testid="source-spec-card"
                style={{
                  background: 'var(--card)',
                  border: '1px solid var(--line)',
                  borderRadius: 12,
                  padding: '18px 20px',
                }}
              >
                <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10.5, color: 'var(--muted)', letterSpacing: '0.08em', textTransform: 'uppercase', fontWeight: 600, marginBottom: 8 }}>
                  Spec (floom.json)
                </div>
                <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 10px', lineHeight: 1.5 }}>
                  Deterministic JSON schema for actions and inputs.
                </p>
                <SourceSnippet
                  value={JSON.stringify({
                    slug: app.slug,
                    version: app.version ?? '0.1.0',
                    actions: Object.keys(app.manifest?.actions ?? {}).slice(0, 2),
                  }, null, 2)}
                />
                <a
                  href={`${window.location.origin}/api/hub/${app.slug}/openapi.json`}
                  target="_blank"
                  rel="noreferrer"
                  style={{ marginTop: 10, display: 'inline-block', fontSize: 12.5, color: 'var(--accent)', fontWeight: 600, textDecoration: 'none' }}
                >
                  View raw spec &rarr;
                </a>
              </div>
            </div>

            {/* Self-host card (full width) */}
            <div
              data-testid="source-selfhost-card"
              style={{
                background: 'var(--card)',
                border: '1px solid var(--line)',
                borderRadius: 12,
                padding: '18px 20px',
              }}
            >
              <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10.5, color: 'var(--muted)', letterSpacing: '0.08em', textTransform: 'uppercase', fontWeight: 600, marginBottom: 8 }}>
                Self-host
              </div>
              <h3 style={{ fontSize: 14, fontWeight: 600, margin: '0 0 8px' }}>Run this app on your own infra.</h3>
              <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 12px', lineHeight: 1.55 }}>
                MIT-licensed. One Docker command, free forever. Bring your own API key.
              </p>
              <SourceSnippet
                value={`docker run -e GEMINI_BYOK=$KEY -p 3000:3000 ghcr.io/floomhq/${app.slug}:latest`}
              />
            </div>
          </section>
        )}
          </div>
          {/* /frame body */}
        </div>
        {/* /permalink-card (G4) */}
      </main>
      <Footer />
      <FeedbackButton />

      {app && (
        <ShareModal
          open={shareModalOpen}
          onClose={() => setShareModalOpen(false)}
          slug={app.slug}
          appName={app.name}
          visibility={app.visibility}
          shareUrl={shareModalUrl || (typeof window !== 'undefined' ? window.location.href : '')}
          isOwner={!!(app.author && sessionUserId && app.author === sessionUserId)}
        />
      )}

      {app && (
        <ClaudeSkillModal
          open={claudeSkillModalOpen}
          onClose={() => setClaudeSkillModalOpen(false)}
          slug={app.slug}
          appName={app.name}
          firstInputName={claudeSkillFirstInput}
        />
      )}

    </div>
  );
}

/* ----------------- small components ----------------- */

/**
 * InstallCard — one of the 3 v26 install tab cards.
 * Shows a warm-dark code snippet + copy button.
 */
function InstallCard({
  testId,
  title,
  desc,
  snippetValue,
  copyLabel,
  copySnippet,
}: {
  testId: string;
  title: string;
  desc: string;
  snippetValue: string;
  copyLabel: string;
  copySnippet?: string;
}) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    try {
      void navigator.clipboard.writeText(copySnippet ?? snippetValue).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      });
    } catch { /* ignore */ }
  };
  return (
    <div
      data-testid={testId}
      style={{
        background: 'var(--card)',
        border: '1px solid var(--line)',
        borderRadius: 14,
        padding: '18px 20px',
      }}
    >
      <h3 style={{ fontSize: 15, fontWeight: 600, margin: '0 0 4px', color: 'var(--ink)' }}>{title}</h3>
      <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 12px', lineHeight: 1.55 }}>{desc}</p>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          background: 'var(--code, #1b1a17)',
          borderRadius: 8,
          padding: '8px 10px',
        }}
      >
        <span
          style={{
            flex: 1,
            fontFamily: 'JetBrains Mono, ui-monospace, monospace',
            fontSize: 12,
            color: 'var(--code-text, #e2e0d9)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}
          dangerouslySetInnerHTML={{ __html: snippetValue.replace(/\n/g, '<br/>') }}
        />
        <button
          type="button"
          onClick={handleCopy}
          style={{
            background: 'rgba(255,255,255,0.08)',
            color: copied ? '#a7f3d0' : 'var(--code-text, #e2e0d9)',
            border: '1px solid rgba(255,255,255,0.15)',
            borderRadius: 6,
            padding: '5px 10px',
            fontSize: 11,
            fontWeight: 600,
            fontFamily: 'inherit',
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          {copied ? 'Copied' : copyLabel}
        </button>
      </div>
    </div>
  );
}

/**
 * SourceSnippet — light tinted code block with a copy button for the Source tab.
 *
 * G8 (2026-04-28): converted from warm-dark to light tinted bg
 * (`var(--studio)`) to match the F7 global "no black copy boxes" rule.
 * Mirrors MvpHeroInstall in LandingV17Page.tsx (~line 100).
 */
function SourceSnippet({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    try {
      void navigator.clipboard.writeText(value).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      });
    } catch { /* ignore */ }
  };
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        background: 'var(--studio, #f5f4f0)',
        border: '1px solid var(--line)',
        borderRadius: 8,
        padding: '8px 10px',
        marginTop: 8,
      }}
    >
      <pre
        style={{
          flex: 1,
          fontFamily: 'JetBrains Mono, ui-monospace, monospace',
          fontSize: 11.5,
          color: 'var(--ink)',
          margin: 0,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
          lineHeight: 1.55,
        }}
      >
        {value}
      </pre>
      <button
        type="button"
        onClick={handleCopy}
        style={{
          background: 'var(--card)',
          color: copied ? 'var(--muted)' : 'var(--accent)',
          border: `1px solid ${copied ? 'var(--line)' : 'rgba(4,120,87,0.35)'}`,
          borderRadius: 6,
          padding: '5px 10px',
          fontSize: 11,
          fontWeight: 600,
          fontFamily: 'inherit',
          cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

/**
 * AboutMetaRow — key/value row for the About tab aside panels.
 */
function AboutMetaRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        padding: '6px 0',
        borderBottom: '1px solid var(--line)',
        fontSize: 12.5,
      }}
    >
      <span style={{ color: 'var(--muted)' }}>{label}</span>
      <span style={{ color: 'var(--ink)', fontWeight: 500, textAlign: 'right' }}>{value}</span>
    </div>
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
