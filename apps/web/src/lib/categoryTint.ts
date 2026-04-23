// Category-tinted backgrounds for app glyph tiles (/apps grid, AppStripe).
// Flat pastels (#91) so neighboring cards read as distinct buckets instead of
// near-identical teal. Icons use a dark foreground on each tint for contrast.

export type CategoryTint = { bg: string; fg: string };

/** Issue #91 palette — keyed by semantic bucket. */
const BUCKET: Record<
  'ai' | 'dev' | 'productivity' | 'analytics' | 'research',
  CategoryTint
> = {
  ai: { bg: '#fef3c7', fg: '#78350f' },
  dev: { bg: '#d7f1e0', fg: '#047857' },
  productivity: { bg: '#dbeafe', fg: '#1e40af' },
  analytics: { bg: '#fce7f3', fg: '#9d174d' },
  research: { bg: '#fef2f2', fg: '#b91c1c' },
};

const NEUTRAL: CategoryTint = { bg: '#f4f4f5', fg: '#27272a' };

/** Maps manifest `HubApp.category` strings → bucket. Unlisted → neutral. */
const CATEGORY_TO_BUCKET: Record<string, keyof typeof BUCKET> = {
  ai: 'ai',
  marketing: 'ai',
  design: 'ai',
  writing: 'ai',
  content: 'ai',
  seo: 'ai',
  text: 'ai',
  sales: 'ai',
  hr: 'ai',
  'developer-tools': 'dev',
  developer_tools: 'dev',
  developer: 'dev',
  utilities: 'dev',
  productivity: 'productivity',
  analytics: 'analytics',
  research: 'research',
};

export function categoryTint(category: string | null | undefined): CategoryTint {
  if (!category) return NEUTRAL;
  const bucket =
    CATEGORY_TO_BUCKET[category] ?? CATEGORY_TO_BUCKET[category.toLowerCase()];
  if (!bucket) return NEUTRAL;
  return BUCKET[bucket];
}
