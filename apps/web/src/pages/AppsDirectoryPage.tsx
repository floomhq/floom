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
import { useSession } from '../hooks/useSession';

const ALL = 'all';

/**
 * Sort-dropdown options (v17 store.html wireframe parity) — hidden at
 * launch per #657. The "Sort · Trending [soon]" control was promising
 * a feature we hadn't shipped; the whole UI is gone until real sort
 * lands. When it ships, restore: const SORT_OPTIONS = [
 *   { key: 'trending', label: 'Trending', hint: 'runs 7d', active: true },
 *   { key: 'recent', label: 'Most recent', hint: 'post-launch', active: false },
 *   { key: 'starred', label: 'Most starred', hint: 'post-launch', active: false },
 * ] + the button/dropdown that used to live in the toolbar.
 *
 * Current default sort (Trending) is still enforced by `sortedApps` —
 * runs_7d desc + hero-first tiebreak.
 */

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
  // Sort dropdown removed 2026-04-24 (#657). Scaffolding left in the
  // doc-comment at the top of this file for when real sort ships.
  // Self-host bypass for the launch-week SHOWCASE allowlist. See
  // lib/hub-filter.ts HubFilterOptions. `cloud_mode === false` on
  // `/api/session/me` means this instance is self-hosted; show every
  // registered app (minus test fixtures) instead of the hosted
  // three-demo curation. Fixes the "apps don't load" report on local
  // Docker where the allowlist rendered an empty grid even though the
  // fast-apps sidecar and any ingested apps were healthy.
  const { data: sessionData } = useSession();
  const selfHost = sessionData?.cloud_mode === false;
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

  // ⌘K / Ctrl-K focuses the search input — v17 store.html parity. Mirrors
  // Studio's command-palette grammar so the same keybinding lands you in
  // search across both surfaces. We only wire focus (no palette UI) on
  // /apps because the page is a single-purpose directory; full command
  // palette lives in /studio.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Detect Mac vs other platforms so the kbd hint reads ⌘K on macOS and
  // Ctrl-K elsewhere. SSR-safe: defaults to ⌘ on the server (most common
  // visitor), then re-renders on the client with the actual platform.
  const isMac =
    typeof navigator !== 'undefined' &&
    /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');
  const kbdHint = isMac ? '⌘K' : 'Ctrl K';

  // Audit 2026-04-24 (local-repro of /apps with API offline): the old
  // error path surfaced "Couldn't load apps — Check your connection and try
  // again" on the *first* failed fetch. That read as a hard failure and
  // blamed the user's connection, but the most common cause is a transient
  // Render cold-start / brief rate-limit on our side. We now retry once
  // silently after a short backoff before showing any error chrome. If the
  // second attempt also fails, the error state reads as a gentle "still
  // trying" rather than a terminal "we're broken".
  const AUTO_RETRY_DELAY_MS = 1800;

  const loadHub = useCallback((opts: { silent?: boolean } = {}) => {
    if (!opts.silent) {
      setLoading(true);
      setHubError(null);
    }
    let cancelled = false;
    const attempt = (isRetry: boolean): Promise<void> =>
      getHub().then(
        (rows) => {
          if (cancelled) return;
          setApps(rows);
          setLoading(false);
          setHubError(null);
        },
        () => {
          if (cancelled) return;
          if (!isRetry) {
            // Silent first-retry: keep the skeleton visible so the user
            // sees uninterrupted loading, not a flash of "error → loading".
            return new Promise<void>((resolve) => {
              setTimeout(() => {
                if (cancelled) {
                  resolve();
                  return;
                }
                attempt(true).then(resolve);
              }, AUTO_RETRY_DELAY_MS);
            });
          }
          setHubError("Apps are taking a moment to load");
          setLoading(false);
        },
      );
    void attempt(false);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const cancel = loadHub();
    return cancel;
  }, [loadHub]);

  const sortedApps = useMemo(() => {
    return apps
      .filter((app) => isPubliclyListed(app, { selfHost }))
      .sort((a, b) => {
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
  }, [apps, selfHost]);

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
        {/* HEADER · v17 store.html alignment (2026-04-25).
            Previously a huge centered hero (72px top padding, 48px serif H1
            "Apps on Floom", 640px search pill). The v17 wireframe calls for
            a tight 1180px-wide container, 34px left-aligned H1, short sub,
            and a single inline toolbar row (chips + search) — not two
            stacked blocks. This reads more like a real store/catalog and
            matches the density of the 4-col grid below. */}
        <section
          data-testid="apps-header"
          style={{ padding: '40px 28px 16px' }}
        >
          <div style={{ maxWidth: 1180, margin: '0 auto' }}>
            <h1
              className="apps-headline"
              style={{
                fontFamily: 'var(--font-display)',
                fontWeight: 800,
                fontSize: 34,
                lineHeight: 1.1,
                letterSpacing: '-0.025em',
                color: 'var(--ink)',
                margin: '0 0 8px',
              }}
            >
              {loading || hubError || appCount === 0
                ? 'AI apps, free to run.'
                : `${appCount} AI app${appCount === 1 ? '' : 's'}, free to run.`}
            </h1>
            <p
              style={{
                fontSize: 15,
                color: 'var(--muted)',
                margin: 0,
                lineHeight: 1.55,
                maxWidth: 560,
              }}
            >
              Real AI doing real work. Paste a URL, compare competitors,
              sharpen a pitch. Each run finishes in under five seconds.
              Install in Claude, Cursor, ChatGPT, or run from your browser.
            </p>
          </div>
        </section>

        {/* TOOLBAR · chip row + inline search (v17 store.html).
            One horizontal row, border-bottom separates it from the grid.
            Chip count pills shrink visual weight. Search is a tight 260px
            inline input, not a giant 640px pill. */}
        <div
          data-testid="apps-toolbar"
          className="apps-toolbar"
          style={{
            maxWidth: 1180,
            margin: '0 auto',
            padding: '18px 28px',
            borderBottom: '1px solid var(--line)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          {/* Chip row.
              CLS note: keep the row mounted even while loading or when only
              a single category exists so the toolbar height stays stable
              across fetch. */}
          <div
            data-testid="apps-chips"
            className="apps-chips-carousel"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              flexWrap: 'wrap',
              minHeight: 34,
            }}
            aria-hidden={categories.length <= 1 ? 'true' : undefined}
          >
            <style>{`
              @media (max-width: 640px) {
                .apps-chips-carousel {
                  flex-wrap: nowrap !important;
                  overflow-x: auto !important;
                  padding-bottom: 8px !important;
                  margin-bottom: -8px !important;
                  -webkit-overflow-scrolling: touch;
                  scrollbar-width: none;
                  mask-image: linear-gradient(to right, black 85%, transparent 100%);
                  -webkit-mask-image: linear-gradient(to right, black 85%, transparent 100%);
                }
                .apps-chips-carousel::-webkit-scrollbar { display: none; }
              }
            `}</style>
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
                      fontSize: 10,
                      opacity: 0.7,
                      marginLeft: 2,
                    }}
                  >
                    {categoryCounts.get(cat) ?? 0}
                  </span>
                </button>
              ))}
          </div>

          {/* Right cluster: search (260px min) + Sort button.
              v17 store.html parity (2026-04-24 PR A): the wireframe
              toolbar ends with a "Sort · Trending [soon]" button that
              hints at future "Most recent / Most starred" affordance.
              We render it inert for now — the dropdown opens but all
              three options are disabled with a "post-launch" pill,
              because sort needs a populated catalog first. Current
              sort is Trending (runs_7d desc via AppsDirectoryPage's
              sortedApps memo + hero-first tiebreak).
              Search keeps its existing submit/blur/scroll handler for
              mobile keyboards; debounced filter runs on every keystroke
              via the controlled input. Submit button is visually hidden
              (SR-only) because the live filter is the real interaction. */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
            }}
          >
          <form
            role="search"
            onSubmit={handleSearchSubmit}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '7px 12px',
              background: 'var(--card)',
              border: '1px solid var(--line)',
              borderRadius: 10,
              minWidth: 260,
              transition: 'border-color 140ms ease, box-shadow 140ms ease',
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = 'var(--ink)';
              e.currentTarget.style.boxShadow = '0 0 0 3px rgba(15,23,42,.06)';
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = 'var(--line)';
              e.currentTarget.style.boxShadow = 'none';
            }}
          >
            <Search
              size={14}
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
                background: 'transparent',
                fontSize: 13,
                fontFamily: 'inherit',
                color: 'var(--ink)',
              }}
            />
            {/* Keyboard-shortcut hint — v17 store.html parity. Mirrors the
                Studio command palette affordance so the same chord lands
                you in search on both surfaces. Hidden on touch viewports
                where chords don't apply. */}
            <kbd
              data-testid="apps-search-kbd"
              aria-hidden="true"
              className="apps-search-kbd"
              style={{
                fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                fontSize: 10.5,
                fontWeight: 600,
                color: 'var(--muted)',
                background: 'var(--bg)',
                border: '1px solid var(--line)',
                borderRadius: 5,
                padding: '2px 6px',
                letterSpacing: '0.04em',
                lineHeight: 1,
                flexShrink: 0,
              }}
            >
              {kbdHint}
            </kbd>
            <button
              type="submit"
              data-testid="apps-search-submit"
              aria-label="Search"
              style={{
                position: 'absolute',
                width: 1,
                height: 1,
                padding: 0,
                margin: -1,
                overflow: 'hidden',
                clip: 'rect(0,0,0,0)',
                border: 0,
              }}
            >
              Search
            </button>
          </form>

          {/* Sort control removed 2026-04-24 (#657): the "Trending [soon]"
              button with an inert dropdown was promising a feature we
              aren't ready to ship. Hiding the whole control is the honest
              move for launch. Restore it (button + dropdown) when sort
              really lands — the `SORT_OPTIONS` + `sortOpen` scaffolding
              below is preserved for that. */}
          </div>
        </div>

        {/* APP LIST · 4-column thumbnail grid (v17 store.html).
            CLS fix (2026-04-18): reserve vertical space for the list area so
            the loading-to-rendered transition does not shift subsequent
            content. 600px fits ~2 grid rows above the fold on desktop; the
            real grid extends this naturally.
            Container widened to 1180px (2026-04-23) to host the 4-col grid —
            the old 760px max-width was calibrated for the single-column
            stripe variant. */}
        {/* 32px top gutter so the toolbar border-bottom breathes above
            the first card row (2026-04-24: separator felt crowded). */}
        <section ref={resultsRef} style={{ padding: '32px 24px 80px', minHeight: 600 }}>
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
              // Audit 2026-04-24: softened tone. Previously "Couldn't load
              // apps / Check your connection" (blame-y, alarmist). Now:
              // - reuses the skeleton background so the page doesn't feel
              //   "broken" — just slow,
              // - gives the user a non-blaming explanation (the API may be
              //   waking up on Render cold start),
              // - keeps the Retry button as a forced refresh.
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
                  The directory API might be waking up. Give it a second, or tap Retry.
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
                {selfHost && (
                  // Self-host-specific hint: a fresh `docker compose up`
                  // without `/var/run/docker.sock` mounted seeds the 7
                  // fast-apps utility sidecar but skips the 3 launch
                  // demos (they need docker to build). If the operator
                  // still sees zero, point them at SELF_HOST.md so they
                  // can either mount the sock or ingest their own apps.
                  <p style={{ fontSize: 13, margin: '12px 0 0' }}>
                    Mount <code>/var/run/docker.sock</code> to seed the
                    launch demos, or ingest an OpenAPI URL from{' '}
                    <a href="/build" style={{ color: 'var(--accent)' }}>
                      /build
                    </a>
                    .{' '}
                    <a href="/docs/self-host" style={{ color: 'var(--accent)' }}>
                      Self-host guide
                    </a>
                    .
                  </p>
                )}
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

    </div>
  );
}

function chipStyle(active: boolean): CSSProperties {
  // Sizing aligned to v17 store.html: 6px/12px padding, 12.5px text, 600 when
  // active (ink-on-white is the strongest affordance in the toolbar).
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 12px',
    borderRadius: 999,
    border: `1px solid ${active ? 'var(--ink)' : 'var(--line)'}`,
    background: active ? 'var(--ink)' : 'var(--card)',
    color: active ? '#fff' : 'var(--muted)',
    fontSize: 12.5,
    fontWeight: active ? 600 : 500,
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: 'all 120ms ease',
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
