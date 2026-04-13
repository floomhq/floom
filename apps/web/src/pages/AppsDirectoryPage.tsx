import { useEffect, useState, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { TopBar } from '../components/TopBar';
import { Footer } from '../components/Footer';
import { AppIcon } from '../components/AppIcon';
import { getHub } from '../api/client';
import type { HubApp } from '../lib/types';

const CATEGORY_LABELS: Record<string, string> = {
  'all': 'All',
  'travel': 'Travel',
  'developer-tools': 'Developer Tools',
  'research': 'Research',
  'marketing': 'Marketing',
  'analytics': 'Analytics',
  'productivity': 'Productivity',
  'writing': 'Writing',
  'ai': 'AI',
  'seo': 'SEO',
};

export function AppsDirectoryPage() {
  const [apps, setApps] = useState<HubApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeCategory, setActiveCategory] = useState('all');
  const [search, setSearch] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    document.title = 'Public apps — Floom';
    getHub()
      .then((a) => {
        setApps(a);
        setLoading(false);
      })
      .catch(() => setLoading(false));

    return () => {
      document.title = 'Floom — infra for agentic work';
    };
  }, []);

  // Derive categories that actually exist in data
  const categories = useMemo(() => {
    const found = new Set<string>();
    apps.forEach((a) => {
      if (a.category) found.add(a.category);
    });
    const ordered = ['all', ...Array.from(found).sort()];
    return ordered;
  }, [apps]);

  const filtered = useMemo(() => {
    let list = apps;
    if (activeCategory !== 'all') {
      list = list.filter((a) => a.category === activeCategory);
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(
        (a) =>
          a.name.toLowerCase().includes(q) ||
          a.description.toLowerCase().includes(q) ||
          (a.category ?? '').toLowerCase().includes(q),
      );
    }
    return list;
  }, [apps, activeCategory, search]);

  const handleSignIn = () => {
    navigate('/chat');
    setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent('floom:pill', { detail: { pill: 'connect-github' } }),
      );
    }, 100);
  };

  return (
    <div className="page-root" data-testid="apps-directory">
      <TopBar onSignIn={handleSignIn} />

      <main className="main" style={{ paddingTop: 48, paddingBottom: 80 }}>
        {/* Hero */}
        <div style={{ marginBottom: 40 }}>
          <h1
            className="headline"
            style={{ maxWidth: 640, fontSize: 42, marginBottom: 12 }}
          >
            Public apps
            <span className="headline-dim"> — agent-ready, right now.</span>
          </h1>
          <p className="subhead" style={{ maxWidth: 560 }}>
            {apps.length > 0 ? apps.length : '15'} tools with a <code style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 14 }}>floom.yaml</code> manifest. Each one exposes a chat interface, an MCP server, an HTTP API, and a CLI endpoint from the same source.
          </p>
        </div>

        {/* Filter bar */}
        <div
          style={{
            display: 'flex',
            gap: 8,
            flexWrap: 'wrap',
            alignItems: 'center',
            marginBottom: 24,
          }}
        >
          <div className="pills" style={{ margin: 0, flexWrap: 'wrap' }}>
            {categories.map((cat) => (
              <button
                key={cat}
                type="button"
                className="pill"
                data-testid={`filter-${cat}`}
                style={{
                  background: activeCategory === cat ? 'var(--accent)' : undefined,
                  color: activeCategory === cat ? '#fff' : undefined,
                  borderColor: activeCategory === cat ? 'var(--accent)' : undefined,
                }}
                onClick={() => setActiveCategory(cat)}
              >
                {CATEGORY_LABELS[cat] ?? cat}
              </button>
            ))}
          </div>

          <input
            type="search"
            className="input-field"
            placeholder="Search apps…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ maxWidth: 220, marginLeft: 'auto' }}
            data-testid="apps-search"
          />
        </div>

        {/* Grid */}
        {loading ? (
          <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--muted)' }}>
            Loading apps…
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState onClear={() => { setActiveCategory('all'); setSearch(''); }} />
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
              gap: 16,
            }}
            data-testid="apps-grid"
          >
            {filtered.map((app) => (
              <AppCard key={app.slug} app={app} onClick={() => {}} />
            ))}
          </div>
        )}

        {/* Submit footer */}
        <div
          style={{
            marginTop: 60,
            padding: '24px',
            background: 'var(--card)',
            border: '1px solid var(--line)',
            borderRadius: 12,
            textAlign: 'center',
          }}
        >
          <p style={{ margin: '0 0 6px', fontSize: 15, fontWeight: 600, color: 'var(--ink)' }}>
            Deploy your own app to this directory.
          </p>
          <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--muted)' }}>
            Add a <code style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12 }}>floom.yaml</code> to any public repo and deploy with the CLI.
          </p>
          <a
            href="https://github.com/floomhq/floom-monorepo"
            target="_blank"
            rel="noreferrer"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '8px 18px',
              background: 'var(--ink)',
              color: '#fff',
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 600,
              textDecoration: 'none',
            }}
          >
            <svg width={14} height={14} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <use href="#icon-github" />
            </svg>
            Check out @floom/cli on GitHub
          </a>
        </div>
      </main>
      <Footer />
    </div>
  );
}

function AppCard({ app, onClick }: { app: HubApp; onClick: () => void }) {
  return (
    <Link
      to={`/p/${app.slug}`}
      className="app-tile"
      data-testid={`app-card-${app.slug}`}
      onClick={onClick}
      style={{
        textAlign: 'left',
        width: '100%',
        padding: '18px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        cursor: 'pointer',
        minHeight: 130,
        textDecoration: 'none',
        color: 'inherit',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div
          style={{
            width: 36,
            height: 36,
            borderRadius: 8,
            border: '1px solid var(--line)',
            background: 'var(--bg)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <AppIcon slug={app.slug} size={20} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 14,
              fontWeight: 700,
              color: 'var(--ink)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {app.name}
          </div>
          {app.author && (
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>
              @{app.author}
            </div>
          )}
        </div>
      </div>

      <p
        style={{
          fontSize: 12,
          color: 'var(--muted)',
          margin: 0,
          lineHeight: 1.5,
          flex: 1,
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        } as React.CSSProperties}
      >
        {app.description}
      </p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {app.category && (
          <span className="category-pill" style={{ fontSize: 10 }}>
            {CATEGORY_LABELS[app.category] ?? app.category}
          </span>
        )}
        <span
          style={{
            marginLeft: 'auto',
            fontSize: 11,
            color: 'var(--muted)',
            fontFamily: 'JetBrains Mono, monospace',
          }}
        >
          new
        </span>
      </div>
    </Link>
  );
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
