/**
 * GitHubStarsBadge — live star count for floomhq/floom with a
 * localStorage cache (10 min TTL) to avoid hammering the GitHub API.
 *
 * Rendered inside the TopBar (desktop + mobile), sitting between the
 * Docs link and the Sign in / Sign up pair.
 *
 * Icon: official GitHub SimpleIcons mark (inline SVG, not text-in-circle).
 *
 * 2026-04-24 audit fix: the badge was rendering a plain "Star" label
 * with no number across both landing + signed-in views, even though
 * the repo has a live star count. Three changes to make the count
 * actually show up:
 *   1. Seed with FALLBACK_COUNT so the first paint always carries a
 *      number. Prevents the no-number state on ANY load.
 *   2. Always render a number (never null).
 *   3. Log non-2xx responses in dev so rate-limits surface.
 *
 * 2026-04-24 (Federico launch-readiness audit): the live fetch used to
 * hit `https://api.github.com/repos/floomhq/floom` directly from the
 * browser. GitHub's anonymous REST budget is 60 req/hour/IP — shared
 * cloud WAFs, office NATs, and most adblock lists silently blocked or
 * 403-rate-limited the call, which produced a console warning on every
 * landing page load. Fetch now goes through the same-origin server
 * proxy at `/api/gh-stars`, which uses a PAT (when set) and a 10-min
 * in-process cache to give every visitor the same live number with no
 * CORS / rate-limit / adblock edge cases. See apps/server/src/routes/
 * gh-stars.ts.
 */
import { useEffect, useState } from 'react';

const REPO = 'floomhq/floom';
const CACHE_KEY = 'floom:gh-stars';
const TTL_MS = 10 * 60 * 1000; // 10 minutes
// Same-origin server proxy — no CORS, no client-side GitHub auth, no
// rate-limit on shared IPs. Server caches for 10 minutes so this path
// costs us at most one upstream GitHub call per 10 minutes per server.
const STARS_ENDPOINT = '/api/gh-stars';
// Floor value — updated at each release so the badge always shows a
// plausible (not inflated) number even when every call fails. The
// server proxy returns this same floor on total upstream failure; we
// keep it in the client as a belt-and-braces seed so the first paint
// always has a number even before the network round-trip completes.
const FALLBACK_COUNT = 60;

type Cached = { count: number; ts: number };

function readCache(): Cached | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Cached;
    if (typeof parsed?.count !== 'number' || typeof parsed?.ts !== 'number') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(count: number): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ count, ts: Date.now() }),
    );
  } catch {
    // Ignore quota/serialisation errors — the UI still works without cache.
  }
}

function formatCount(n: number): string {
  if (n >= 1000) {
    return (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k';
  }
  return String(n);
}

export interface GitHubStarsBadgeProps {
  /** Visually compact variant used inside the TopBar pill row. */
  compact?: boolean;
  /** Hide label on narrow screens — show just the star count. */
  dataTestId?: string;
}

export function GitHubStarsBadge({
  compact = false,
  dataTestId = 'gh-stars-badge',
}: GitHubStarsBadgeProps) {
  // Seed with cached count if we have one; otherwise fall back to the
  // static floor so we NEVER render the "Star" no-number state. The
  // effect below refreshes the value with a live fetch when we can.
  const [count, setCount] = useState<number>(() => {
    const cached = readCache();
    return cached?.count ?? FALLBACK_COUNT;
  });

  useEffect(() => {
    const cached = readCache();
    const fresh = cached && Date.now() - cached.ts < TTL_MS;
    if (fresh && cached) {
      setCount(cached.count);
      return;
    }
    let cancelled = false;
    fetch(STARS_ENDPOINT, {
      headers: { Accept: 'application/json' },
    })
      .then(async (r) => {
        if (!r.ok) {
          if (import.meta.env.DEV) {
            // eslint-disable-next-line no-console
            console.warn(`[GitHubStarsBadge] /api/gh-stars responded ${r.status}`);
          }
          return null;
        }
        return r.json();
      })
      .then((d: { count?: number } | null) => {
        if (cancelled || !d || typeof d.count !== 'number') return;
        setCount(d.count);
        writeCache(d.count);
      })
      .catch((err) => {
        if (import.meta.env.DEV) {
          // eslint-disable-next-line no-console
          console.warn('[GitHubStarsBadge] fetch failed', err);
        }
        // Network failure — keep whatever fallback/cached value we have.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const label = formatCount(count);

  return (
    <a
      href={`https://github.com/${REPO}`}
      target="_blank"
      rel="noreferrer"
      aria-label={`floomhq/floom on GitHub (${count} stars)`}
      data-testid={dataTestId}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: compact ? '5px 9px' : '7px 11px',
        borderRadius: 999,
        fontSize: compact ? 12 : 13,
        fontWeight: 600,
        lineHeight: 1,
        color: '#0e0e0c',
        background: '#fafaf8',
        border: '1px solid rgba(14,14,12,0.18)',
        textDecoration: 'none',
        transition: 'border-color 0.12s, background 0.12s',
      }}
    >
      <svg
        width={compact ? 13 : 14}
        height={compact ? 13 : 14}
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
      >
        {/* SimpleIcons `github` mark — real SVG path, not text-in-circle. */}
        <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
      </svg>
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{label}</span>
    </a>
  );
}
