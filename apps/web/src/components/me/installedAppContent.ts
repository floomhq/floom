// Static content map for the /me/apps installed-apps grid.
//
// Why static + not API-fetched:
//   - The decision doc Flag #2 + Flag #3 (recommended default B + A)
//     called out that the current API does NOT expose app descriptions
//     or run-output snippets in the list response. Doing N+1 fetches per
//     card to fill them in is expensive and makes the grid loading flash.
//   - Federico-locked launch roster is small (3 AI apps + a few utility
//     apps); a curated map is cheap and stays in lockstep with the
//     wireframe + showcase row content.
//
// When a slug isn't in the map (a user installed something off-roster),
// we fall back to a generic banner derived from the run preview so the
// card still has something honest to show.
//
// Banner content here mirrors AppShowcaseRow's SHOWCASE_ENTRIES so the
// /apps directory and /me/apps surface the same run-state visual.

import type { BannerLine } from '../public/BannerCard';

export interface InstalledAppEntry {
  /** Display name fallback when run.app_name is missing. */
  name: string;
  /** 1-line description rendered as the .desc lede on the card. */
  description: string;
  /** Mono uppercase cap shown in the top-left of the thumb. */
  categoryLabel: string;
  /** Free-form category used by the tag-filter strip. */
  category: 'research' | 'writing' | 'dev' | 'utility';
  /** Mono title inside the banner-card. */
  bannerTitle: string;
  /** 1-4 lines for the banner-card mini-preview. */
  bannerLines: BannerLine[];
  /** Tag chips rendered below the sparkline. */
  tags: string[];
}

export const INSTALLED_APP_CONTENT: Record<string, InstalledAppEntry> = {
  'competitor-lens': {
    name: 'Competitor Lens',
    description: 'Compare your positioning to a competitor. Powered by Gemini 3 Pro.',
    categoryLabel: 'Research',
    category: 'research',
    bannerTitle: 'competitor-lens',
    bannerLines: [
      { text: 'stripe vs adyen' },
      { text: 'fee 1.4% vs 1.6%', dim: true },
      { text: 'winner: stripe', accent: true },
    ],
    tags: ['research', 'positioning', 'gemini'],
  },
  'ai-readiness-audit': {
    name: 'AI Readiness Audit',
    description: "Score a company's AI readiness on a single URL.",
    categoryLabel: 'Research',
    category: 'research',
    bannerTitle: 'ai-readiness',
    bannerLines: [
      { text: 'floom.dev' },
      { text: 'score: 8.4/10', dim: true },
      { text: '3 risks · 3 wins', accent: true },
    ],
    tags: ['research', 'positioning'],
  },
  'pitch-coach': {
    name: 'Pitch Coach',
    description: 'Roast and rewrite a startup pitch in your voice.',
    categoryLabel: 'Writing',
    category: 'writing',
    bannerTitle: 'pitch-coach',
    bannerLines: [
      { text: 'harsh truth' },
      { text: '3 critiques', accent: true },
      { text: '3 rewrites', dim: true },
    ],
    tags: ['writing', 'pitch'],
  },
  'jwt-decode': {
    name: 'JWT Decode',
    description: 'Paste a JWT, see header / payload / signature.',
    categoryLabel: 'Dev',
    category: 'dev',
    bannerTitle: 'jwt-decode',
    bannerLines: [
      { text: 'eyJhbGci…' },
      { text: 'alg: RS256', dim: true },
      { text: 'exp: 14d', accent: true },
    ],
    tags: ['utility', 'debug'],
  },
  'json-format': {
    name: 'JSON Format',
    description: 'Pretty-print + validate JSON in your clipboard.',
    categoryLabel: 'Dev',
    category: 'dev',
    bannerTitle: 'json-format',
    bannerLines: [
      { text: 'paste any JSON' },
      { text: '2-space indent', dim: true },
      { text: 'valid ✓', accent: true },
    ],
    tags: ['utility', 'json'],
  },
  password: {
    name: 'Password',
    description: 'Generate a strong password — copy + paste.',
    categoryLabel: 'Utility',
    category: 'utility',
    bannerTitle: 'password',
    bannerLines: [
      { text: '24 chars · alpha+sym' },
      { text: 'entropy: 154 bits', dim: true },
      { text: 'copied ✓', accent: true },
    ],
    tags: ['utility', 'security'],
  },
  uuid: {
    name: 'UUID',
    description: 'Generate v4/v7 UUIDs — copy one, copy a hundred.',
    categoryLabel: 'Utility',
    category: 'utility',
    bannerTitle: 'uuid',
    bannerLines: [
      { text: '018f4e6a-7b9c-7…' },
      { text: 'v7 · time-ordered', dim: true },
      { text: 'copied ✓', accent: true },
    ],
    tags: ['utility', 'id'],
  },
  opendraft: {
    name: 'OpenDraft',
    description: 'Reply to WhatsApp + email in your voice.',
    categoryLabel: 'Writing',
    category: 'writing',
    bannerTitle: 'opendraft',
    bannerLines: [
      { text: 'whatsapp · cedik' },
      { text: 'draft · 3 lines', dim: true },
      { text: 'tone: warm', accent: true },
    ],
    tags: ['whatsapp', 'drafting'],
  },
  flyfast: {
    name: 'FlyFast',
    description: 'Natural-language flight search.',
    categoryLabel: 'Utility',
    category: 'utility',
    bannerTitle: 'flyfast',
    bannerLines: [
      { text: 'HAM → LIS' },
      { text: 'fri 22 may', dim: true },
      { text: '€89 · trust 92', accent: true },
    ],
    tags: ['travel', 'utility'],
  },
};

/**
 * Resolve banner content for a slug, falling back to a generic
 * 1-line banner derived from the slug + run-count when off-roster.
 */
export function resolveInstalledAppEntry(
  slug: string,
  fallbackName: string,
  runCount: number,
): InstalledAppEntry {
  const known = INSTALLED_APP_CONTENT[slug];
  if (known) return known;
  return {
    name: fallbackName,
    description: `Custom app installed from /apps.`,
    categoryLabel: 'Utility',
    category: 'utility',
    bannerTitle: slug,
    bannerLines: [
      { text: slug, dim: true },
      {
        text: `${runCount} run${runCount === 1 ? '' : 's'} this week`,
        dim: true,
      },
    ],
    tags: [],
  };
}

export const TAG_FILTER_CATEGORIES: ReadonlyArray<{
  id: 'all' | 'research' | 'writing' | 'dev' | 'utility';
  label: string;
}> = [
  { id: 'all', label: 'All' },
  { id: 'research', label: 'Research' },
  { id: 'writing', label: 'Writing' },
  { id: 'dev', label: 'Dev' },
  { id: 'utility', label: 'Utility' },
];
