import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { useSearchParams } from 'react-router-dom';
import { Search } from 'lucide-react';
import { TopBar } from '../components/TopBar';
import { PublicFooter } from '../components/public/PublicFooter';
import { AppGrid } from '../components/public/AppGrid';
import { FeedbackButton } from '../components/FeedbackButton';
import { PageHead } from '../components/PageHead';
import { getHub } from '../api/client';
import type { HubApp } from '../lib/types';
import { isPubliclyListed } from '../lib/hub-filter';

const ALL = 'all';

const CATEGORY_LABELS: Record<string, string> = {
  all: 'All',
  travel: 'Travel',
  'developer-tools': 'Developer',
  research: 'Research',
  marketing: 'Marketing',
  analytics: 'Analytics',
  productivity: 'Productivity',
  writing: 'Writing',
  ai: 'AI',
  seo: 'SEO',
  design: 'Design',
};

function labelForCategory(category: string): string {
  // Backend emits a mix of slug-cased (developer-tools) and snake-cased
  // (open_data, developer_tools) values. Normalize both at display time
  // so chips always read as "Open data", "Developer tools" — not
  // "Open_data" or "Developer-tools". URL + filter state keep the raw
  // value, so this is purely cosmetic.
  return (
    CATEGORY_LABELS[category] ??
    category
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

/**
 * Small debounce hook so the search input doesn't thrash the filtered
 * list on every keystroke. 150ms matches the v15 spec.
 */
function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

export function AppsDirectoryPage() {
  const [apps, setApps] = useState<HubApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [hubError, setHubError] = useState<string | null>(null);
  const [rawSearch, setRawSearch] = useState('');
  // Category filter is URL-backed so browser back/forward and shared URLs
  // restore the filtered view (#100). ALL is the implicit default — we
  // only write `?category=<slug>` to the URL when the user picks a
  // non-default chip so the canonical /apps URL stays clean.
  const [searchParams, setSearchParams] = useSearchParams();
  const activeCategory = searchParams.get('category') || ALL;
  const setActiveCategory = useCallback(
    (cat: string) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (cat === ALL) {
            next.delete('category');
          } else {
            next.set('category', cat);
          }
          return next;
        },
        { replace: false },
      );
    },
    [setSearchParams],
  );

  const search = useDebounced(rawSearch, 150);

  // Refs for the search-submit wiring. Filtering already happens on each
  // keystroke via `search`, but users reasonably expect the Search button
  // to *do* something. Pre-fix it was `preventDefault()` only, which felt
  // broken on mobile where the keyboard obscured the results (route-02
  // audit A2, 2026-04-20). We keep the debounced filter as the behavior
  // and make submit scroll to the results + blur the input so the
  // keyboard collapses.
  const searchInputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLElement>(null);

  const handleSearchSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    searchInputRef.current?.blur();
    resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const loadHub = useCallback(() => {
    setLoading(true);
    setHubError(null);
    getHub()
      .then((rows) => {
        setApps(rows);
        setLoading(false);
      })
      .catch(() => {
        setHubError("Couldn't load apps");
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    loadHub();
  }, [loadHub]);

  const sortedApps = useMemo(() => {
    return apps.filter(isPubliclyListed).sort((a, b) => {
      if ((a.featured ?? false) !== (b.featured ?? false)) {
        return a.featured ? -1 : 1;
      }
      if (a.avg_run_ms != null || b.avg_run_ms != null) {
        if (a.avg_run_ms == null) return 1;
        if (b.avg_run_ms == null) return -1;
        if (a.avg_run_ms !== b.avg_run_ms) return a.avg_run_ms - b.avg_run_ms;
      }
      return a.name.localeCompare(b.name);
    });
  }, [apps]);

  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>([[ALL, sortedApps.length]]);
    for (const app of sortedApps) {
      if (!app.category) continue;
      counts.set(app.category, (counts.get(app.category) ?? 0) + 1);
    }
    return counts;
  }, [sortedApps]);

  const categories = useMemo(() => {
    const found = new Set<string>();
    for (const app of sortedApps) {
      if (app.category) found.add(app.category);
    }
    const ordered = Array.from(found).sort((a, b) => {
      const ca = categoryCounts.get(a) ?? 0;
      const cb = categoryCounts.get(b) ?? 0;
      if (ca !== cb) return cb - ca;
      return labelForCategory(a).localeCompare(labelForCategory(b));
    });
    return [ALL, ...ordered];
  }, [sortedApps, categoryCounts]);

  const trimmedSearch = search.trim().toLowerCase();

  const filteredApps = useMemo(() => {
    let list = sortedApps;
    if (activeCategory !== ALL) {
      list = list.filter((app) => app.category === activeCategory);
    }
    if (trimmedSearch) {
      list = list.filter((app) =>
        [
          app.name,
          app.description,
          app.category ?? '',
          app.author ?? '',
          app.author_display ?? '',
        ]
          .join(' ')
          .toLowerCase()
          .includes(trimmedSearch),
      );
    }
    return list;
  }, [sortedApps, activeCategory, trimmedSearch]);

  const appCount = sortedApps.length;

  return (
    <div
      className="page-root"
      data-testid="apps-directory"
      style={{ minHeight: '100vh', background: 'var(--bg)' }}
    >
      <PageHead
        title="Apps · Floom"
        description="Browse AI apps on Floom. Each one runs as a Claude tool, a shareable page, a command-line, and a clean HTTP endpoint."
      />
      <TopBar />

      <main>
        {/* HEADER · mono-tag + serif H1 + subhead */}
        <section
          style={{
            padding: '72px 24px 36px',
            background:
              'radial-gradient(ellipse 800px 360px at 50% 30%, rgba(5,150,105,0.05), transparent 70%)',
          }}
        >
          <div style={{ maxWidth: 900, margin: '0 auto', textAlign: 'center' }}>
            <span
              style={{
                fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                fontSize: 11,
                color: 'var(--muted)',
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                fontWeight: 500,
              }}
            >
              PUBLIC DIRECTORY ·{' '}
              {loading || hubError ? '—' : `${appCount} APP${appCount === 1 ? '' : 'S'}`}
            </span>

            <h1
              className="apps-headline"
              style={{
                fontFamily: "'DM Serif Display', Georgia, serif",
                fontWeight: 400,
                fontSize: 48,
                lineHeight: 1.1,
                letterSpacing: '-0.02em',
                color: 'var(--ink)',
                margin: '18px 0 12px',
              }}
            >
              Apps on Floom
            </h1>
            <p
              style={{
                fontSize: 16,
                color: 'var(--muted)',
                margin: '0 0 36px',
                lineHeight: 1.6,
              }}
            >
              Run them. Fork them. Or build your own.
            </p>

            {/* Google-style search pill */}
            <form
              role="search"
              onSubmit={handleSearchSubmit}
              style={{
                background: 'var(--card)',
                border: '1.5px solid var(--line)',
                borderRadius: 999,
                padding: '8px 8px 8px 22px',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                maxWidth: 640,
                margin: '0 auto',
                transition: 'border-color 140ms ease, box-shadow 140ms ease',
              }}
              onFocus={(e) => {
                const el = e.currentTarget;
                el.style.borderColor = 'var(--ink)';
                el.style.boxShadow = '0 4px 0 var(--ink)';
              }}
              onBlur={(e) => {
                const el = e.currentTarget;
                el.style.borderColor = 'var(--line)';
                el.style.boxShadow = 'none';
              }}
            >
              <Search
                size={18}
                aria-hidden="true"
                style={{ color: 'var(--muted)', flexShrink: 0 }}
              />
              <input
                ref={searchInputRef}
                type="text"
                value={rawSearch}
                onChange={(e) => setRawSearch(e.target.value)}
                placeholder="Search apps…"
                aria-label="Search apps"
                data-testid="apps-search"
                style={{
                  flex: 1,
                  minWidth: 0,
                  border: 0,
                  outline: 'none',
                  padding: '14px 0',
                  fontSize: 15,
                  background: 'transparent',
                  color: 'var(--ink)',
                }}
              />
              <button
                type="submit"
                data-testid="apps-search-submit"
                style={{
                  background: 'var(--ink)',
                  color: '#fff',
                  border: 0,
                  borderRadius: 999,
                  padding: '11px 20px',
                  fontWeight: 600,
                  fontSize: 14,
                  cursor: 'pointer',
                  flexShrink: 0,
                }}
              >
                Search
              </button>
            </form>

            {/* Category chip strip.
                CLS fix (2026-04-18): reserve min-height so the strip does not
                pop in once hub data loads. Chip buttons are ~36px tall; the
                28px marginTop + strip height rounds to ~64px. Loading /
                single-category states render an invisible placeholder of the
                same height. */}
            <div
              style={{
                minHeight: 64,
                marginTop: 28,
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'center',
                gap: 8,
                flexWrap: 'wrap',
              }}
              data-testid="apps-chips"
              aria-hidden={categories.length <= 1 ? 'true' : undefined}
            >
              {categories.length > 1 &&
                categories.map((cat) => (
                  <button
                    key={cat}
                    type="button"
                    data-testid={`chip-${cat}`}
                    onClick={() => setActiveCategory(cat)}
                    style={chipStyle(activeCategory === cat)}
                  >
                    <span>{labelForCategory(cat)}</span>
                    <span
                      style={{
                        fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                        fontSize: 11,
                        opacity: 0.7,
                      }}
                    >
                      {categoryCounts.get(cat) ?? 0}
                    </span>
                  </button>
                ))}
            </div>
          </div>
        </section>

        {/* APP LIST · 4-column thumbnail grid (v17 store.html).
            CLS fix (2026-04-18): reserve vertical space for the list area so
            the loading-to-rendered transition does not shift subsequent
            content. 600px fits ~2 grid rows above the fold on desktop; the
            real grid extends this naturally.
            Container widened to 1180px (2026-04-23) to host the 4-col grid —
            the old 760px max-width was calibrated for the single-column
            stripe variant. */}
        <section ref={resultsRef} style={{ padding: '0 24px 80px', minHeight: 600 }}>
          <div style={{ maxWidth: 1180, margin: '0 auto' }}>
            {loading ? (
              <div
                className="apps-grid-skeleton"
                data-testid="apps-list-skeleton"
                aria-busy="true"
                aria-label="Loading apps"
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(4, 1fr)',
                  gap: 16,
                }}
              >
                {Array.from({ length: 8 }).map((_, i) => (
                  <AppGridSkeleton key={i} />
                ))}
              </div>
            ) : hubError ? (
              <div
                data-testid="apps-hub-error"
                style={{
                  border: '1px solid var(--line)',
                  borderRadius: 12,
                  background: 'var(--card)',
                  padding: '28px 24px',
                  textAlign: 'center',
                }}
              >
                <p
                  style={{
                    fontSize: 16,
                    fontWeight: 600,
                    color: 'var(--ink)',
                    margin: '0 0 8px',
                  }}
                >
                  {hubError}
                </p>
                <p style={{ fontSize: 14, color: 'var(--muted)', margin: '0 0 18px', lineHeight: 1.55 }}>
                  Check your connection and try again.
                </p>
                <button
                  type="button"
                  data-testid="apps-hub-retry"
                  onClick={() => loadHub()}
                  style={{
                    background: 'var(--ink)',
                    color: '#fff',
                    border: 0,
                    borderRadius: 999,
                    padding: '10px 22px',
                    fontSize: 14,
                    fontWeight: 600,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  Retry
                </button>
              </div>
            ) : appCount === 0 ? (
              <div
                data-testid="apps-directory-empty"
                style={{
                  textAlign: 'center',
                  padding: '60px 0',
                  color: 'var(--muted)',
                }}
              >
                <p style={{ fontSize: 16, margin: 0 }}>
                  No apps in the directory yet.
                </p>
              </div>
            ) : filteredApps.length === 0 ? (
              <div
                data-testid="apps-empty"
                style={{
                  textAlign: 'center',
                  padding: '60px 0',
                  color: 'var(--muted)',
                }}
              >
                <p style={{ fontSize: 16, margin: '0 0 10px' }}>
                  No apps match &ldquo;{rawSearch.trim()}&rdquo;
                  {activeCategory !== ALL ? ` in ${labelForCategory(activeCategory)}` : ''}.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setRawSearch('');
                    setActiveCategory(ALL);
                  }}
                  style={{
                    background: 'var(--card)',
                    border: '1px solid var(--line)',
                    borderRadius: 999,
                    padding: '8px 16px',
                    fontSize: 13,
                    fontWeight: 500,
                    color: 'var(--ink)',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  Clear filters
                </button>
              </div>
            ) : (
              <AppGrid apps={filteredApps} />
            )}
          </div>
        </section>
      </main>

      <PublicFooter />
      <FeedbackButton />

      <style>{`
        @media (max-width: 640px) {
          .apps-headline { font-size: 30px !important; }
          /* Directory hero: tighten padding on mobile so the search
             pill isn't pushed below the fold. Also bump the input
             font-size to 16px so iOS Safari stops auto-zooming when
             the field gains focus (it zooms anything <16px). */
          [data-testid="apps-directory"] main > section:first-of-type { padding: 40px 16px 24px !important; }
          [data-testid="apps-search"] { font-size: 16px !important; }
          /* Category chip strip: tighter gap, still wraps. */
          [data-testid="apps-chips"] { gap: 6px !important; }
          /* Results section: smaller gutter, smaller bottom padding. */
          [data-testid="apps-directory"] main > section:nth-of-type(2) { padding: 0 16px 48px !important; }
        }
        /* Mirror AppGrid breakpoints so the loading skeleton collapses the
           same way as the real grid: 4 → 3 → 2 → 1. Keeps grid shape stable
           across the load transition. */
        @media (max-width: 1024px) {
          .apps-grid-skeleton { grid-template-columns: repeat(3, 1fr) !important; }
        }
        @media (max-width: 760px) {
          .apps-grid-skeleton { grid-template-columns: repeat(2, 1fr) !important; }
        }
        @media (max-width: 480px) {
          .apps-grid-skeleton { grid-template-columns: 1fr !important; }
        }
        @keyframes apps-skeleton-shimmer {
          0% { background-position: -200px 0; }
          100% { background-position: calc(200px + 100%) 0; }
        }
      `}</style>
    </div>
  );
}

function chipStyle(active: boolean): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    padding: '9px 16px',
    borderRadius: 999,
    border: `1px solid ${active ? 'var(--ink)' : 'var(--line)'}`,
    background: active ? 'var(--ink)' : 'var(--card)',
    color: active ? '#fff' : 'var(--ink)',
    fontSize: 13.5,
    fontWeight: 500,
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: 'all 140ms ease',
  };
}

/**
 * Placeholder card shown while the hub fetch is pending.
 *
 * Matches AppGrid's card shape: 120px thumbnail slot + title row + 2-line
 * description + footer strip. Keeps the first-paint shape stable so the
 * real cards land without a layout shift.
 */
function AppGridSkeleton() {
  const shimmer: CSSProperties = {
    background:
      'linear-gradient(90deg, var(--line) 0%, rgba(0,0,0,0.04) 50%, var(--line) 100%)',
    backgroundSize: '200px 100%',
    backgroundRepeat: 'no-repeat',
    animation: 'apps-skeleton-shimmer 1.2s ease-in-out infinite',
    borderRadius: 6,
  };
  return (
    <div
      aria-hidden="true"
      style={{
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--card)',
        border: '1px solid var(--line)',
        borderRadius: 14,
        overflow: 'hidden',
      }}
    >
      <div style={{ height: 120, ...shimmer, borderRadius: 0 }} />
      <div style={{ padding: '14px 16px 16px' }}>
        <div style={{ height: 14, width: '58%', ...shimmer }} />
        <div style={{ height: 12, width: '90%', marginTop: 10, ...shimmer }} />
        <div style={{ height: 12, width: '72%', marginTop: 6, ...shimmer }} />
        <div
          style={{
            marginTop: 14,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <div style={{ height: 18, width: 70, borderRadius: 999, ...shimmer }} />
          <div style={{ height: 12, width: 42, ...shimmer }} />
        </div>
      </div>
    </div>
  );
}
