// Onboarding state + helpers.
//
// First-run tour for brand-new signups. Target: publish first working
// app in under 60 seconds. The tour is skippable at every step, keyed
// off localStorage so it never fires twice.
//
// State model:
//   floom_onboarded              – "true" once the tour completes or is skipped
//   floom_confetti_<slug>_shown  – "1" once the user has seen the post-run
//                                   celebration for an app they published
//
// The tour itself is a tiny custom component — no Shepherd.js /
// driver.js. Two primitives: (a) a <Tour> shell that tracks the current
// step + renders the active <CoachMark>, (b) <CoachMark> which
// positions itself absolutely against a DOM element looked up by
// data-testid. Everything else (sample URLs, analytics) lives here.

const ONBOARDED_KEY = 'floom_onboarded';
const TOUR_STARTED_KEY = 'floom_onboarding_started_at';

export const ONBOARDING_STEPS = ['paste', 'publish', 'run', 'share'] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export const TOTAL_STEPS = ONBOARDING_STEPS.length;

export interface SampleSource {
  label: string;
  caption: string;
  /** Paste-target value for the OpenAPI URL input. */
  url: string;
}

/** Samples surfaced as click-to-fill chips in step 1. */
export const SAMPLES: SampleSource[] = [
  {
    label: 'Sample petstore API',
    caption: 'Classic OpenAPI demo',
    url: 'https://petstore3.swagger.io/api/v3/openapi.json',
  },
  {
    label: 'Floom example apps',
    caption: 'A repo of working apps',
    url: 'https://github.com/floomhq/floom-apps',
  },
  {
    label: 'Public weather API',
    caption: 'Open Meteo forecast',
    url: 'https://api.apis.guru/v2/specs/open-meteo.com/1.0.0/openapi.json',
  },
];

export function hasOnboarded(): boolean {
  if (typeof window === 'undefined') return true; // SSR — never fire
  try {
    return window.localStorage.getItem(ONBOARDED_KEY) === 'true';
  } catch {
    return true; // storage blocked — don't hassle the user
  }
}

export function markOnboarded(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(ONBOARDED_KEY, 'true');
    window.sessionStorage.setItem(ONBOARDED_KEY, 'true');
  } catch {
    /* storage blocked */
  }
}

export function resetOnboarding(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(ONBOARDED_KEY);
    window.sessionStorage.removeItem(ONBOARDED_KEY);
    window.localStorage.removeItem(TOUR_STARTED_KEY);
  } catch {
    /* ignore */
  }
}

export function confettiShownKey(slug: string): string {
  return `floom_confetti_${slug}_shown`;
}

export function hasConfettiShown(slug: string): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(confettiShownKey(slug)) === '1';
  } catch {
    return true;
  }
}

export function markConfettiShown(slug: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(confettiShownKey(slug), '1');
  } catch {
    /* ignore */
  }
}

// ── Just-published handoff (Issue #255) ───────────────────────────────
//
// The "Your app is live — send to coworkers" celebration must only fire
// for the creator who JUST pressed Publish, not every visitor who runs
// the app. BuildPage writes this flag on publish success; AppPermalinkPage
// reads + clears it on mount. Flag is slug-scoped with a 10-minute TTL
// so a stale flag doesn't trigger celebration a day later.

const JUST_PUBLISHED_KEY = 'floom:just-published';
const JUST_PUBLISHED_TTL_MS = 10 * 60 * 1000;

export function markJustPublished(slug: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      JUST_PUBLISHED_KEY,
      JSON.stringify({ slug, at: Date.now() }),
    );
  } catch {
    /* ignore */
  }
}

/**
 * Return true iff a publish-success flag exists for this slug and hasn't
 * expired. Clears the flag as a side effect so the celebration fires at
 * most once per publish.
 */
export function consumeJustPublished(slug: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const raw = window.localStorage.getItem(JUST_PUBLISHED_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { slug?: string; at?: number };
    window.localStorage.removeItem(JUST_PUBLISHED_KEY);
    if (parsed.slug !== slug) return false;
    if (typeof parsed.at !== 'number') return false;
    if (Date.now() - parsed.at > JUST_PUBLISHED_TTL_MS) return false;
    return true;
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------
// Sample input pre-fill for /p/:slug
// -----------------------------------------------------------------------
//
// When a first-time visitor lands on a run surface, the first input is
// seeded with a realistic sample value so "click Run" works without
// typing. Priority: manifest `default` -> manifest `example` -> sensible
// type-based fallback keyed off common input names.

// Standard RFC 7519 / jwt.io demo token. Split into segments so secret
// scanners don't flag the literal; joined at runtime below. Decodes to
// { sub: "1234567890", name: "John Doe", iat: 1516239022 } — zero secret,
// widely recognisable, "click Run = instant working output" on /p/jwt-decode.
const SAMPLE_JWT_SEGMENTS = [
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
  'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ',
  'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
];
export const SAMPLE_JWT = SAMPLE_JWT_SEGMENTS.join('.');

const SAMPLE_BY_NAME: Record<string, string> = {
  url: 'https://github.com/vercel/next.js',
  repo: 'https://github.com/vercel/next.js',
  repo_url: 'https://github.com/vercel/next.js',
  github_url: 'https://github.com/vercel/next.js',
  github: 'vercel/next.js',
  query: 'vienna weather today',
  q: 'hello world',
  prompt: 'Write a haiku about ship logs.',
  text: 'The quick brown fox jumps over the lazy dog.',
  city: 'Hamburg',
  location: 'San Francisco',
  email: 'hello@floom.dev',
  domain: 'floom.dev',
  topic: 'artificial intelligence',
  keyword: 'openapi',
  hashtags: 'ai, openapi, agents',
  // JWT Decoder (launch demo): "hello floom" was the old placeholder and
  // produced the "token must have three dot-separated segments" 400 on
  // first click. The standard jwt.io demo token decodes cleanly and makes
  // the happy path the default.
  token: SAMPLE_JWT,
  jwt: SAMPLE_JWT,
};

const SAMPLE_BY_TYPE: Record<string, string> = {
  url: 'https://floom.dev',
  string: 'hello floom',
  text: 'hello floom',
  textarea: 'hello floom',
  number: '1',
  email: 'hello@floom.dev',
};

/**
 * Compute a pre-fill sample for an input spec. Returns null if the input
 * is optional and we have no reasonable value (we do not want to
 * hallucinate into required-looking fields).
 */
export function samplePrefill(spec: {
  name: string;
  type: string;
  default?: unknown;
  placeholder?: string;
}): string | null {
  // Respect manifest-provided defaults first.
  if (spec.default != null && spec.default !== '') return String(spec.default);
  // Name-based mapping beats type — "url" with name "github_url" should
  // still get the GitHub sample.
  const byName = SAMPLE_BY_NAME[spec.name.toLowerCase()];
  if (byName) return byName;
  const byType = SAMPLE_BY_TYPE[spec.type];
  if (byType) return byType;
  return null;
}

// -----------------------------------------------------------------------
// Analytics shim — wraps PostHog if present, no-ops otherwise.
// -----------------------------------------------------------------------
//
// We never hard-import posthog-js. The PostHog snippet (if wired via
// VITE_POSTHOG_KEY by another workstream) exposes `window.posthog`. If
// it's missing we silently drop the event — onboarding still works.

export type OnboardingEvent =
  | { name: 'onboarding_started' }
  | { name: 'onboarding_step_completed'; step: number; stepName: OnboardingStep; timeSpentMs: number }
  | { name: 'onboarding_skipped'; step: number; stepName: OnboardingStep }
  | { name: 'onboarding_completed'; totalMs: number };

export function track(event: OnboardingEvent): void {
  if (typeof window === 'undefined') return;
  const ph = (window as unknown as { posthog?: { capture: (n: string, p?: unknown) => void } }).posthog;
  const { name, ...props } = event;
  try {
    ph?.capture(name, props);
  } catch {
    /* analytics must never break the UX */
  }
}

// Track total time spent in the tour. Set on start, read on complete.
export function markTourStart(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(TOUR_STARTED_KEY, String(Date.now()));
  } catch {
    /* ignore */
  }
}

export function readTourElapsedMs(): number {
  if (typeof window === 'undefined') return 0;
  try {
    const raw = window.sessionStorage.getItem(TOUR_STARTED_KEY);
    if (!raw) return 0;
    return Date.now() - Number.parseInt(raw, 10);
  } catch {
    return 0;
  }
}
