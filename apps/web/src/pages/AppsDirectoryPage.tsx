import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { TopBar } from '../components/TopBar';
import { Footer } from '../components/Footer';
import { AppIcon } from '../components/AppIcon';
import { FeedbackButton } from '../components/FeedbackButton';
import { getHub } from '../api/client';
import { LAUNCH_APPS } from '../data/demoData';
import type { HubApp } from '../lib/types';

const CATEGORY_LABELS: Record<string, string> = {
  all: 'All',
  travel: 'Travel',
  'developer-tools': 'Developer Tools',
  research: 'Research',
  marketing: 'Marketing',
  analytics: 'Analytics',
  productivity: 'Productivity',
  writing: 'Writing',
  ai: 'AI',
  seo: 'SEO',
};

const SHELF_DEFS: Array<{
  key: string;
  title: string;
  description: string;
  categories: string[];
}> = [
  {
    key: 'productivity',
    title: 'Productivity',
    description: 'Useful, repeatable tools people can run right away.',
    categories: ['productivity'],
  },
  {
    key: 'research-writing',
    title: 'Research and writing',
    description: 'Apps for papers, posts, keywords, and briefs.',
    categories: ['research', 'writing', 'seo'],
  },
  {
    key: 'marketing-analytics',
    title: 'Marketing and analytics',
    description: 'Go-to-market, buyer context, and reporting workflows.',
    categories: ['marketing', 'analytics', 'ai'],
  },
  {
    key: 'developer-tools',
    title: 'Developer tools',
    description: 'Diffs, checks, and utilities for technical workflows.',
    categories: ['developer-tools'],
  },
  {
    key: 'travel',
    title: 'Travel',
    description: 'Search and compare real-world flight options.',
    categories: ['travel'],
  },
];

const CURATED_ORDER = LAUNCH_APPS.map((app) => app.slug);
const CURATED_INDEX = new Map(CURATED_ORDER.map((slug, index) => [slug, index]));

export function AppsDirectoryPage() {
  const [apps, setApps] = useState<HubApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeCategory, setActiveCategory] = useState('all');
  const [search, setSearch] = useState('');
  const trimmedSearch = search.trim();

  useEffect(() => {
    document.title = 'Apps · Floom store';
    getHub()
      .then((rows) => {
        setApps(rows);
        setLoading(false);
      })
      .catch(() => setLoading(false));

    return () => {
      document.title = 'Floom · Production infrastructure for AI apps that do real work';
    };
  }, []);

  const sortedApps = useMemo(() => {
    return [...apps].sort((a, b) => compareApps(a, b));
  }, [apps]);

  const categories = useMemo(() => {
    const found = new Set<string>();
    for (const app of sortedApps) {
      if (app.category) found.add(app.category);
    }
    return ['all', ...Array.from(found).sort()];
  }, [sortedApps]);

  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>([['all', sortedApps.length]]);
    for (const app of sortedApps) {
      if (!app.category) continue;
      counts.set(app.category, (counts.get(app.category) || 0) + 1);
    }
    return counts;
  }, [sortedApps]);

  const filteredApps = useMemo(() => {
    let list = sortedApps;
    if (activeCategory !== 'all') {
      list = list.filter((app) => app.category === activeCategory);
    }
    if (trimmedSearch) {
      const query = trimmedSearch.toLowerCase();
      list = list.filter((app) =>
        [app.name, app.description, app.category || '', app.author || '']
          .join(' ')
          .toLowerCase()
          .includes(query),
      );
    }
    return list;
  }, [sortedApps, activeCategory, trimmedSearch]);

  const isFiltered = activeCategory !== 'all' || trimmedSearch.length > 0;

  const featuredCount = useMemo(
    () => sortedApps.filter((app) => app.featured).length,
    [sortedApps],
  );

  const runnableCount = useMemo(
    () => sortedApps.filter((app) => !app.blocked_reason).length,
    [sortedApps],
  );

  const runNowApp = useMemo(
    () => sortedApps.find((app) => !app.blocked_reason) ?? sortedApps[0] ?? null,
    [sortedApps],
  );

  const noteworthyApps = useMemo(() => {
    if (isFiltered) return [];
    const bySlug = new Map(sortedApps.map((app) => [app.slug, app]));
    const launchApps = CURATED_ORDER.map((slug) => bySlug.get(slug)).filter(Boolean) as HubApp[];
    return dedupeBySlug([...launchApps, ...sortedApps]).slice(0, 3);
  }, [isFiltered, sortedApps]);

  const spotlightApp = useMemo(() => {
    if (isFiltered) return null;
    return noteworthyApps[0] ?? runNowApp;
  }, [isFiltered, noteworthyApps, runNowApp]);

  const shelfRows = useMemo(() => {
    if (isFiltered) return [];
    const used = new Set(noteworthyApps.map((app) => app.slug));
    return SHELF_DEFS.map((shelf) => {
      const items = sortedApps
        .filter(
          (app) => !used.has(app.slug) && shelf.categories.includes(app.category || ''),
        )
        .slice(0, 4);
      items.forEach((app) => used.add(app.slug));
      return { ...shelf, items };
    }).filter((shelf) => shelf.items.length > 0);
  }, [isFiltered, noteworthyApps, sortedApps]);

  const shelfSlugSet = useMemo(() => {
    const used = new Set<string>(noteworthyApps.map((app) => app.slug));
    for (const shelf of shelfRows) {
      for (const app of shelf.items) used.add(app.slug);
    }
    return used;
  }, [noteworthyApps, shelfRows]);

  const remainingApps = useMemo(() => {
    if (isFiltered) return [];
    return sortedApps.filter((app) => !shelfSlugSet.has(app.slug));
  }, [isFiltered, sortedApps, shelfSlugSet]);

  const clearFilters = () => {
    setActiveCategory('all');
    setSearch('');
  };

  return (
    <div className="page-root" data-testid="apps-directory">
      <TopBar />

      <main className="main" style={{ maxWidth: 1180, paddingTop: 28, paddingBottom: 96 }}>
        <section style={{ marginBottom: 32 }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
              gap: 16,
              alignItems: 'start',
            }}
          >
            <div
              style={{
                background: 'linear-gradient(180deg, rgba(255,255,255,0.97), rgba(248,250,252,0.92))',
                border: '1px solid var(--line)',
                borderRadius: 16,
                padding: 22,
                boxShadow: '0 8px 30px rgba(15,23,42,0.04)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  justifyContent: 'space-between',
                  gap: 18,
                  flexWrap: 'wrap',
                  marginBottom: 18,
                }}
              >
                <div style={{ minWidth: 0, flex: '1 1 360px' }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      flexWrap: 'wrap',
                      marginBottom: 8,
                    }}
                  >
                    <p className="label-mono" style={{ margin: 0 }}>
                      Store
                    </p>
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '4px 9px',
                        borderRadius: 999,
                        border: '1px solid rgba(5,150,105,0.16)',
                        background: 'rgba(5,150,105,0.08)',
                        color: '#047857',
                        fontSize: 11,
                        fontWeight: 700,
                      }}
                    >
                      <span
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: '50%',
                          background: 'currentColor',
                        }}
                      />
                      {loading ? 'Loading live catalog' : `${apps.length} live on preview`}
                    </span>
                  </div>
                  <h1
                    style={{
                      margin: '0 0 10px',
                      fontSize: 34,
                      lineHeight: 1.08,
                      fontWeight: 700,
                      color: 'var(--ink)',
                      maxWidth: 580,
                    }}
                  >
                    Browse the live catalog.
                  </h1>
                  <p
                    style={{
                      margin: 0,
                      maxWidth: 640,
                      fontSize: 15,
                      lineHeight: 1.6,
                      color: 'var(--muted)',
                    }}
                  >
                    Open the run surface, inspect endpoints, or move straight into a real category
                    shelf. Everything below is grounded in the current hub payload and current app
                    routes.
                  </p>
                </div>

                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(2, minmax(118px, 1fr))',
                    gap: 10,
                    width: 'min(100%, 320px)',
                  }}
                >
                  <StoreStatTile label="Live apps" value={String(apps.length || 0)} />
                  <StoreStatTile label="Runnable" value={String(runnableCount)} />
                  <StoreStatTile label="Featured" value={String(featuredCount)} />
                  <StoreStatTile label="Categories" value={String(Math.max(categories.length - 1, 0))} />
                </div>
              </div>

              <div
                style={{
                  border: '1px solid var(--line)',
                  borderRadius: 14,
                  padding: 14,
                  background: 'rgba(255,255,255,0.84)',
                }}
              >
                <label
                  htmlFor="apps-search"
                  className="label-mono"
                  style={{ display: 'block', marginBottom: 8 }}
                >
                  Search + filter
                </label>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    border: '1px solid var(--line)',
                    borderRadius: 12,
                    background: 'var(--bg)',
                    padding: '0 14px',
                  }}
                >
                  <svg width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.4" />
                    <path
                      d="M10.5 10.5L14 14"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                    />
                  </svg>
                  <input
                    id="apps-search"
                    type="search"
                    placeholder="Search apps, creators, categories, or descriptions"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    data-testid="apps-search"
                    style={{
                      width: '100%',
                      minWidth: 0,
                      height: 46,
                      border: 'none',
                      outline: 'none',
                      background: 'transparent',
                      fontSize: 14,
                      fontFamily: 'inherit',
                      color: 'var(--ink)',
                    }}
                  />
                </div>

                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                    flexWrap: 'wrap',
                    marginTop: 12,
                  }}
                >
                  <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
                    {isFiltered
                      ? `Showing ${filteredApps.length} matching app${filteredApps.length === 1 ? '' : 's'} in the live preview catalog.`
                      : 'Featured shelves and the full catalog update immediately as you browse.'}
                  </p>
                  {isFiltered && (
                    <button
                      type="button"
                      onClick={clearFilters}
                      style={compactGhostButtonStyle}
                    >
                      Clear filters
                    </button>
                  )}
                </div>
              </div>

              <div className="pills" style={{ marginTop: 14, marginBottom: 0, gap: 10, flexWrap: 'wrap' }}>
                {categories.map((category) => (
                  <button
                    key={category}
                    type="button"
                    data-testid={`filter-${category}`}
                    onClick={() => setActiveCategory(category)}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 8,
                      minHeight: 38,
                      padding: '8px 12px',
                      borderRadius: 999,
                      border:
                        activeCategory === category
                          ? '1px solid var(--ink)'
                          : '1px solid var(--line)',
                      background:
                        activeCategory === category
                          ? 'var(--ink)'
                          : 'rgba(255,255,255,0.72)',
                      color: activeCategory === category ? '#fff' : 'var(--ink)',
                      fontSize: 13,
                      fontWeight: 600,
                      fontFamily: 'inherit',
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    <span>{labelForCategory(category)}</span>
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        minWidth: 20,
                        height: 20,
                        borderRadius: 999,
                        padding: '0 6px',
                        background:
                          activeCategory === category
                            ? 'rgba(255,255,255,0.16)'
                            : 'rgba(15,23,42,0.06)',
                        color: activeCategory === category ? '#fff' : 'var(--muted)',
                        fontSize: 11,
                        fontWeight: 700,
                      }}
                    >
                      {categoryCounts.get(category) ?? 0}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <aside
              style={{
                background: 'var(--card)',
                border: '1px solid var(--line)',
                borderRadius: 16,
                padding: 22,
                boxShadow: '0 8px 24px rgba(15,23,42,0.04)',
              }}
            >
              <p
                className="label-mono"
                style={{ marginBottom: 8, display: 'flex', justifyContent: 'space-between' }}
              >
                <span>Run now</span>
                <span>{runNowApp?.blocked_reason ? 'Inspectable' : 'Runnable'}</span>
              </p>
              <p style={{ margin: '0 0 8px', fontSize: 23, fontWeight: 700, color: 'var(--ink)' }}>
                {runNowApp?.name || 'Store preview'}
              </p>
              <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
                {runNowApp
                  ? `${runNowApp.description} Jump into the run tab or inspect endpoints from the same permalink.`
                  : 'The store is live on preview, with real permalink pages behind every card.'}
              </p>

              {runNowApp && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 14 }}>
                  {runNowApp.category && (
                    <span className="category-pill">{labelForCategory(runNowApp.category)}</span>
                  )}
                  <MetaPill label={speedLabel(runNowApp)} />
                  <MetaPill label={runNowApp.runtime} />
                  <MetaPill
                    label={
                      runNowApp.actions[0]
                        ? `Starts with ${formatActionLabel(runNowApp.actions[0])}`
                        : 'Run tab ready'
                    }
                  />
                </div>
              )}

              {runNowApp?.blocked_reason && (
                <div
                  style={{
                    marginTop: 14,
                    padding: '11px 12px',
                    borderRadius: 12,
                    border: '1px solid #fed7aa',
                    background: '#fff7ed',
                    color: '#9a3412',
                    fontSize: 12,
                    lineHeight: 1.55,
                  }}
                >
                  {runNowApp.blocked_reason}
                </div>
              )}

              <div style={{ display: 'grid', gap: 10, marginTop: 16 }}>
                {runNowApp && (
                  <Link to={primaryHref(runNowApp)} style={primaryStoreButtonStyle}>
                    {runNowApp.blocked_reason ? 'Inspect app' : 'Open run surface'}
                    <ArrowRight size={14} />
                  </Link>
                )}
                {runNowApp && (
                  <Link to={`/p/${runNowApp.slug}?tab=endpoints`} style={secondaryStoreButtonStyle}>
                    View endpoints
                  </Link>
                )}
                <Link to="/build" style={secondaryStoreButtonStyle}>
                  Deploy an app
                </Link>
              </div>

              <div
                style={{
                  marginTop: 16,
                  paddingTop: 16,
                  borderTop: '1px solid var(--line)',
                  display: 'grid',
                  gap: 10,
                }}
              >
                <StoreRouteRow label="Store route" value="/apps" />
                <StoreRouteRow label="Run route" value="/p/:slug?tab=run" />
                <StoreRouteRow label="Endpoints tab" value="/p/:slug?tab=endpoints" />
                <StoreRouteRow label="Source tab" value="/p/:slug?tab=source" />
              </div>
            </aside>
          </div>
        </section>

        {loading ? (
          <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--muted)' }}>
            Loading apps...
          </div>
        ) : filteredApps.length === 0 ? (
          <EmptyState
            onClear={clearFilters}
          />
        ) : isFiltered ? (
          <section>
            <SectionHeader
              eyebrow="Results"
              title={`${filteredApps.length} app${filteredApps.length === 1 ? '' : 's'} found`}
              description={
                activeCategory !== 'all' && trimmedSearch
                  ? `Matching ${labelForCategory(activeCategory)} apps for "${trimmedSearch}".`
                  : activeCategory !== 'all'
                  ? `Browsing the ${labelForCategory(activeCategory)} shelf from the live preview catalog.`
                  : `Search results for "${trimmedSearch}" from the live preview catalog.`
              }
              action={
                <button type="button" onClick={clearFilters} style={compactGhostButtonStyle}>
                  Clear filters
                </button>
              }
            />
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))',
                gap: 16,
              }}
              data-testid="apps-grid"
            >
              {filteredApps.map((app) => (
                <StoreAppCard key={app.slug} app={app} />
              ))}
            </div>
          </section>
        ) : (
          <>
            {noteworthyApps.length > 0 && (
              <section style={{ marginBottom: 44 }}>
                <SectionHeader
                  eyebrow="Featured"
                  title="Start with the runnable front shelf."
                  description="Curated from the live preview catalog so the first screen reads like a store and each card opens a real run or endpoints surface."
                />
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
                    gap: 16,
                  }}
                >
                  {noteworthyApps.map((app) => (
                    <FeaturedStoreCard
                      key={app.slug}
                      app={app}
                      spotlight={spotlightApp?.slug === app.slug}
                    />
                  ))}
                </div>
              </section>
            )}

            {shelfRows.map((shelf) => (
              <section key={shelf.key} style={{ marginBottom: 44 }}>
                <SectionHeader
                  eyebrow="Shelf"
                  title={shelf.title}
                  description={shelf.description}
                />
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
                    gap: 16,
                  }}
                >
                  {shelf.items.map((app) => (
                    <StoreAppCard key={app.slug} app={app} />
                  ))}
                </div>
              </section>
            ))}

            {remainingApps.length > 0 && (
              <section style={{ marginBottom: 28 }}>
                <SectionHeader
                  eyebrow="Everything live"
                  title="More apps on preview."
                  description="The rest of the live catalog, still searchable and still runnable."
                />
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
                    gap: 16,
                  }}
                  data-testid="apps-grid"
                >
                  {remainingApps.map((app) => (
                    <StoreAppCard key={app.slug} app={app} />
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </main>

      <Footer />
      <FeedbackButton />
    </div>
  );
}

function SectionHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div
      style={{
        marginBottom: 18,
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        gap: 14,
        flexWrap: 'wrap',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <p className="label-mono" style={{ marginBottom: 8 }}>
          {eyebrow}
        </p>
        <h2
          className="section-title-display"
          style={{ marginBottom: 8, maxWidth: 720, fontSize: 30, lineHeight: 1.08 }}
        >
          {title}
        </h2>
        <p
          style={{
            margin: 0,
            maxWidth: 680,
            fontSize: 14,
            color: 'var(--muted)',
            lineHeight: 1.55,
          }}
        >
          {description}
        </p>
      </div>
      {action}
    </div>
  );
}

function FeaturedStoreCard({ app, spotlight = false }: { app: HubApp; spotlight?: boolean }) {
  return (
    <article
      data-testid={`featured-card-${app.slug}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        minHeight: spotlight ? 320 : 280,
        padding: spotlight ? 24 : 22,
        borderRadius: 16,
        border: '1px solid var(--line)',
        background: spotlight
          ? 'linear-gradient(180deg, rgba(5,150,105,0.08), rgba(255,255,255,0.98))'
          : 'var(--card)',
        color: 'inherit',
        boxShadow: '0 12px 26px rgba(15,23,42,0.05)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
          <div
            style={{
              width: spotlight ? 52 : 48,
              height: spotlight ? 52 : 48,
              borderRadius: 14,
              border: '1px solid var(--line)',
              background: 'var(--bg)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <AppIcon slug={app.slug} size={spotlight ? 30 : 28} />
          </div>
          <div style={{ minWidth: 0 }}>
            <p className="label-mono" style={{ margin: '0 0 6px' }}>
              {spotlight ? 'Spotlight app' : 'Featured app'}
            </p>
            <p
              style={{
                margin: 0,
                fontSize: spotlight ? 20 : 18,
                fontWeight: 700,
                color: 'var(--ink)',
                lineHeight: 1.15,
              }}
            >
              {app.name}
            </p>
          </div>
        </div>

        <StoreStatusPill app={app} />
      </div>

      <div>
        {app.author && (
          <p style={{ margin: '0 0 10px', fontSize: 12, color: 'var(--muted)' }}>by @{app.author}</p>
        )}
        <p
          style={{
            margin: 0,
            fontSize: spotlight ? 14 : 13,
            color: 'var(--muted)',
            lineHeight: 1.65,
          }}
        >
          {app.description}
        </p>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {app.category && (
          <span className="category-pill">{labelForCategory(app.category)}</span>
        )}
        <MetaPill label={app.runtime} />
        <MetaPill label={`${app.actions.length} action${app.actions.length === 1 ? '' : 's'}`} />
        <MetaPill label={speedLabel(app)} />
      </div>

      {app.actions.length > 0 && (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 8,
            padding: '10px 12px',
            borderRadius: 12,
            background: 'rgba(15,23,42,0.04)',
          }}
        >
          {app.actions.slice(0, spotlight ? 3 : 2).map((action) => (
            <span key={action} style={actionPreviewStyle}>
              {formatActionLabel(action)}
            </span>
          ))}
        </div>
      )}

      {app.blocked_reason && (
        <div style={blockedReasonStyle}>{app.blocked_reason}</div>
      )}

      <div style={{ marginTop: 'auto' }}>
        <StoreActionRow app={app} prominent={spotlight} />
      </div>
    </article>
  );
}

function StoreAppCard({ app }: { app: HubApp }) {
  return (
    <article
      className="app-tile"
      data-testid={`app-card-${app.slug}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        minHeight: 236,
        padding: 18,
        color: 'inherit',
        borderRadius: 14,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1 }}>
          <div
            className="app-tile-icon"
            style={{
              width: 38,
              height: 38,
              marginBottom: 0,
              border: '1px solid var(--line)',
              background: 'var(--bg)',
            }}
          >
            <AppIcon slug={app.slug} size={20} />
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <p
              className="app-tile-name"
              style={{
                marginBottom: 2,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                fontSize: 14,
              }}
            >
              {app.name}
            </p>
            <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)' }}>
              {app.author ? `@${app.author}` : 'floomhq'}
            </p>
          </div>
        </div>
        <StoreStatusPill app={app} compact={true} />
      </div>

      <p className="app-tile-desc" style={{ marginBottom: 0, fontSize: 12 }}>
        {app.description}
      </p>

      {app.actions.length > 0 && (
        <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
          Starts with <strong style={{ color: 'var(--ink)' }}>{formatActionLabel(app.actions[0])}</strong>
          {app.actions.length > 1 ? ` +${app.actions.length - 1} more` : ''}
        </p>
      )}

      {app.blocked_reason && <div style={blockedReasonStyle}>{app.blocked_reason}</div>}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 'auto' }}>
        {app.category && (
          <span className="category-pill" style={{ fontSize: 10 }}>
            {labelForCategory(app.category)}
          </span>
        )}
        <MetaPill label={app.runtime} />
        <MetaPill label={`${app.actions.length} action${app.actions.length === 1 ? '' : 's'}`} />
        <MetaPill label={speedLabel(app)} />
      </div>

      <StoreActionRow app={app} compact={true} />
    </article>
  );
}

function MetaPill({ label }: { label: string }) {
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 600,
        padding: '4px 7px',
        borderRadius: 999,
        border: '1px solid var(--line)',
        background: 'var(--bg)',
        color: 'var(--muted)',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  );
}

function speedLabel(app: HubApp): string {
  if (typeof app.avg_run_ms === 'number') return `${Math.round(app.avg_run_ms)} ms avg`;
  return 'Live on preview';
}

function compareApps(a: HubApp, b: HubApp): number {
  const curatedA = CURATED_INDEX.get(a.slug);
  const curatedB = CURATED_INDEX.get(b.slug);
  if (curatedA !== undefined || curatedB !== undefined) {
    if (curatedA === undefined) return 1;
    if (curatedB === undefined) return -1;
    if (curatedA !== curatedB) return curatedA - curatedB;
  }
  if ((a.featured ?? false) !== (b.featured ?? false)) {
    return (b.featured ? 1 : 0) - (a.featured ? 1 : 0);
  }
  if (a.avg_run_ms != null || b.avg_run_ms != null) {
    if (a.avg_run_ms == null) return 1;
    if (b.avg_run_ms == null) return -1;
    if (a.avg_run_ms !== b.avg_run_ms) return a.avg_run_ms - b.avg_run_ms;
  }
  return a.name.localeCompare(b.name);
}

function dedupeBySlug(apps: HubApp[]): HubApp[] {
  const seen = new Set<string>();
  return apps.filter((app) => {
    if (seen.has(app.slug)) return false;
    seen.add(app.slug);
    return true;
  });
}

function EmptyState({ onClear }: { onClear: () => void }) {
  return (
    <div
      style={{
        textAlign: 'center',
        padding: '60px 0',
        color: 'var(--muted)',
      }}
    >
      <p style={{ fontSize: 16, marginBottom: 12 }}>No apps match your filters.</p>
      <button
        type="button"
        onClick={onClear}
        style={{
          padding: '8px 18px',
          background: 'var(--card)',
          border: '1px solid var(--line)',
          borderRadius: 8,
          fontSize: 13,
          cursor: 'pointer',
          fontFamily: 'inherit',
          color: 'var(--ink)',
        }}
      >
        Clear filters
      </button>
    </div>
  );
}

function StoreActionRow({
  app,
  compact = false,
  prominent = false,
}: {
  app: HubApp;
  compact?: boolean;
  prominent?: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: compact ? 'flex-start' : 'space-between',
        gap: 12,
        flexWrap: 'wrap',
      }}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        <Link
          to={primaryHref(app)}
          style={prominent ? featuredPrimaryButtonStyle : compact ? compactPrimaryButtonStyle : cardPrimaryButtonStyle}
        >
          {app.blocked_reason ? 'Inspect app' : compact ? 'Run app' : 'Open run surface'}
          <ArrowRight size={13} />
        </Link>
        <Link to={`/p/${app.slug}?tab=endpoints`} style={inlineActionLinkStyle}>
          Endpoints
        </Link>
        {!compact && (
          <Link to={`/p/${app.slug}?tab=source`} style={inlineActionLinkStyle}>
            Source
          </Link>
        )}
      </div>

      {!compact && (
        <Link to={`/p/${app.slug}`} style={detailLinkStyle}>
          Details
        </Link>
      )}
    </div>
  );
}

function StoreStatusPill({ app, compact = false }: { app: HubApp; compact?: boolean }) {
  const blocked = !!app.blocked_reason;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: compact ? '5px 8px' : '6px 10px',
        borderRadius: 999,
        border: blocked ? '1px solid #fed7aa' : '1px solid rgba(5,150,105,0.18)',
        background: blocked ? '#fff7ed' : 'rgba(5,150,105,0.08)',
        color: blocked ? '#9a3412' : '#047857',
        fontSize: compact ? 10 : 11,
        fontWeight: 700,
        whiteSpace: 'nowrap',
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: 'currentColor',
          flexShrink: 0,
        }}
      />
      {blocked ? 'Inspect' : 'Runnable'}
    </span>
  );
}

function StoreStatTile({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        padding: '12px 13px',
        borderRadius: 14,
        border: '1px solid var(--line)',
        background: 'rgba(255,255,255,0.72)',
      }}
    >
      <p
        className="label-mono"
        style={{ margin: '0 0 8px', fontSize: 10, color: 'var(--muted)' }}
      >
        {label}
      </p>
      <p style={{ margin: 0, fontSize: 22, fontWeight: 700, color: 'var(--ink)' }}>{value}</p>
    </div>
  );
}

function StoreRouteRow({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
      }}
    >
      <span style={{ fontSize: 12, color: 'var(--muted)' }}>{label}</span>
      <code
        style={{
          fontSize: 11,
          fontFamily: 'JetBrains Mono, monospace',
          color: 'var(--ink)',
          background: 'var(--bg)',
          border: '1px solid var(--line)',
          borderRadius: 999,
          padding: '4px 8px',
          whiteSpace: 'normal',
          wordBreak: 'break-word',
          textAlign: 'right',
        }}
      >
        {value}
      </code>
    </div>
  );
}

function labelForCategory(category: string): string {
  return CATEGORY_LABELS[category] ?? category.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatActionLabel(action: string): string {
  return action.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function primaryHref(app: HubApp): string {
  return app.blocked_reason ? `/p/${app.slug}` : `/p/${app.slug}?tab=run`;
}

const compactGhostButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: 34,
  padding: '8px 12px',
  borderRadius: 999,
  border: '1px solid var(--line)',
  background: 'rgba(255,255,255,0.84)',
  color: 'var(--ink)',
  fontSize: 12,
  fontWeight: 600,
  fontFamily: 'inherit',
  cursor: 'pointer',
};

const primaryStoreButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  minHeight: 44,
  padding: '12px 16px',
  borderRadius: 12,
  background: 'var(--ink)',
  color: '#fff',
  border: '1px solid var(--ink)',
  fontSize: 14,
  fontWeight: 700,
  textDecoration: 'none',
};

const secondaryStoreButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: 42,
  padding: '11px 16px',
  borderRadius: 12,
  border: '1px solid var(--line)',
  background: 'var(--card)',
  color: 'var(--ink)',
  fontSize: 13,
  fontWeight: 600,
  textDecoration: 'none',
};

const featuredPrimaryButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  minHeight: 40,
  padding: '10px 14px',
  borderRadius: 12,
  border: '1px solid var(--ink)',
  background: 'var(--ink)',
  color: '#fff',
  fontSize: 13,
  fontWeight: 700,
  textDecoration: 'none',
};

const cardPrimaryButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  minHeight: 38,
  padding: '9px 13px',
  borderRadius: 10,
  border: '1px solid var(--ink)',
  background: 'var(--ink)',
  color: '#fff',
  fontSize: 12,
  fontWeight: 700,
  textDecoration: 'none',
};

const compactPrimaryButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 7,
  minHeight: 36,
  padding: '8px 12px',
  borderRadius: 10,
  border: '1px solid var(--ink)',
  background: 'var(--ink)',
  color: '#fff',
  fontSize: 12,
  fontWeight: 700,
  textDecoration: 'none',
};

const inlineActionLinkStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  minHeight: 36,
  color: 'var(--ink)',
  fontSize: 12,
  fontWeight: 600,
  textDecoration: 'none',
};

const detailLinkStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  minHeight: 36,
  color: 'var(--muted)',
  fontSize: 12,
  fontWeight: 600,
  textDecoration: 'none',
};

const blockedReasonStyle: CSSProperties = {
  padding: '10px 12px',
  borderRadius: 12,
  border: '1px solid #fed7aa',
  background: '#fff7ed',
  color: '#9a3412',
  fontSize: 12,
  lineHeight: 1.55,
};

const actionPreviewStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  minHeight: 28,
  padding: '4px 9px',
  borderRadius: 999,
  border: '1px solid rgba(15,23,42,0.08)',
  background: 'rgba(255,255,255,0.82)',
  color: 'var(--ink)',
  fontSize: 11,
  fontWeight: 600,
};
