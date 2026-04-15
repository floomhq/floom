import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { TopBar } from '../components/TopBar';
import { AppIcon } from '../components/AppIcon';
import { getHub } from '../api/client';
import type { HubApp } from '../lib/types';

export function BrowsePage() {
  const [apps, setApps] = useState<HubApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    getHub()
      .then((data) => setApps(data))
      .catch((e) => setErr((e as Error).message))
      .finally(() => setLoading(false));
  }, []);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const a of apps) if (a.category) set.add(a.category);
    return ['all', ...Array.from(set).sort()];
  }, [apps]);

  const visible = apps.filter((a) => {
    if (category && category !== 'all' && a.category !== category) return false;
    if (query) {
      const q = query.toLowerCase();
      const hay = `${a.name} ${a.description} ${a.category || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  return (
    <div className="page-root">
      <TopBar />
      <main className="main" style={{ maxWidth: 1100, paddingTop: 64, paddingBottom: 96 }}>
        <h1 className="headline" style={{ fontSize: 42 }}>
          All apps
        </h1>
        <p className="subhead">
          {apps.length} apps live on this instance. Every one is callable via chat, MCP, and HTTP.
        </p>

        <div
          style={{
            display: 'flex',
            gap: 12,
            alignItems: 'center',
            flexWrap: 'wrap',
            marginBottom: 24,
          }}
        >
          <input
            className="input-field"
            type="text"
            placeholder="Search apps…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ maxWidth: 260 }}
          />
          {categories.map((c) => (
            <button
              key={c}
              type="button"
              className="pill"
              style={{
                background: c === (category ?? 'all') ? 'var(--accent-soft)' : 'var(--card)',
                borderColor: c === (category ?? 'all') ? 'var(--accent)' : 'var(--line)',
                color: c === (category ?? 'all') ? 'var(--accent)' : 'var(--ink)',
              }}
              onClick={() => setCategory(c === 'all' ? null : c)}
            >
              {c}
            </button>
          ))}
        </div>

        {loading && <p className="label-mono">Loading…</p>}
        {err && (
          <p className="label-mono" style={{ color: '#9a3a19' }}>
            Failed to load: {err}
          </p>
        )}

        {!loading && !err && (
          <div
            className="trending-grid"
            style={{
              gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
              gap: 16,
            }}
          >
            {visible.map((app) => (
              <button
                key={app.slug}
                type="button"
                className="app-tile"
                onClick={() => {
                  // Start a chat with a placeholder prompt for this app.
                  navigate('/');
                  setTimeout(() => {
                    // Rely on the store being re-initialized by ChatPage.
                    import('../store/chatStore').then(({ useChatStore }) => {
                      useChatStore
                        .getState()
                        .submitPrompt(`Run ${app.name}: ${app.description}`);
                    });
                  }, 80);
                }}
                style={{ textAlign: 'left' }}
              >
                <div className="app-tile-icon">
                  <AppIcon slug={app.slug} size={24} />
                </div>
                <div className="app-tile-name">{app.name}</div>
                <div className="app-tile-desc">{app.description}</div>
                <div className="app-tile-runs">
                  {app.category || 'app'} · {app.actions.length}{' '}
                  action{app.actions.length === 1 ? '' : 's'}
                </div>
                {app.blocked_reason && (
                  <div
                    className="app-tile-blocked"
                    title={app.blocked_reason}
                    style={{
                      marginTop: 8,
                      fontSize: 11,
                      fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                      color: '#9a3a19',
                      background: 'rgba(154, 58, 25, 0.08)',
                      border: '1px solid rgba(154, 58, 25, 0.22)',
                      padding: '6px 8px',
                      borderRadius: 6,
                      lineHeight: 1.35,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    hosted-mode only · {app.blocked_reason}
                  </div>
                )}
              </button>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
