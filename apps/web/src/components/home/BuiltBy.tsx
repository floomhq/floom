/**
 * BuiltBy — small, tasteful "who's behind this" block above the footer.
 *
 * Pulls the GitHub star count from the same-origin server proxy
 * `/api/gh-stars` at mount time. Previously this hit api.github.com
 * directly from the browser, which 403-rate-limited on shared IPs /
 * office NATs / adblock-equipped sessions and spammed the console on
 * every load. The server proxy caches upstream for 10 minutes and uses
 * a PAT when set, so one upstream call covers all visitors.
 * If the proxy fails, we silently hide the star badge and keep the
 * static text: never fabricate a number.
 */
import { useEffect, useState } from 'react';

const GH_REPO = 'floomhq/floom';
const STARS_ENDPOINT = '/api/gh-stars';

interface StarState {
  stars: number | null;
  loaded: boolean;
}

export function BuiltBy() {
  const [state, setState] = useState<StarState>({ stars: null, loaded: false });

  useEffect(() => {
    let cancelled = false;
    fetch(STARS_ENDPOINT, {
      headers: { Accept: 'application/json' },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { count?: number } | null) => {
        if (cancelled) return;
        const stars =
          data && typeof data.count === 'number' ? (data.count as number) : null;
        setState({ stars, loaded: true });
      })
      .catch(() => {
        if (cancelled) return;
        setState({ stars: null, loaded: true });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section
      data-testid="home-built-by"
      data-section="built-by"
      style={{
        background: 'var(--bg)',
        padding: '56px 24px 72px',
        borderTop: '1px solid var(--line)',
      }}
    >
      <div
        style={{
          maxWidth: 720,
          margin: '0 auto',
          textAlign: 'center',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 14,
        }}
      >
        <p style={{ margin: 0, fontSize: 15, color: 'var(--muted)', lineHeight: 1.55 }}>
          Built in SF by{' '}
          <a
            href="https://github.com/federicodeponte"
            target="_blank"
            rel="noreferrer"
            style={{ color: 'var(--ink)', textDecoration: 'underline', fontWeight: 500 }}
          >
            @federicodeponte
          </a>
          . Everything is on GitHub, yours to read, fork, or run yourself.
        </p>
        <a
          href={`https://github.com/${GH_REPO}`}
          target="_blank"
          rel="noreferrer"
          data-testid="built-by-github"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 10,
            background: 'var(--card)',
            border: '1px solid var(--line)',
            borderRadius: 10,
            padding: '10px 16px',
            fontSize: 13.5,
            fontWeight: 500,
            color: 'var(--ink)',
            textDecoration: 'none',
          }}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
          </svg>
          <span>github.com/{GH_REPO}</span>
          {state.loaded && state.stars !== null && (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                color: 'var(--muted)',
                borderLeft: '1px solid var(--line)',
                paddingLeft: 10,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true">
                <path d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.28l-3.046 2.97.719 4.192a.75.75 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.375a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z" />
              </svg>
              {state.stars.toLocaleString()}
            </span>
          )}
        </a>
      </div>
    </section>
  );
}
