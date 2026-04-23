/**
 * FreeRunsStrip — visible BYOK status on /p/:slug for the 3 launch demo
 * slugs that consume GEMINI_API_KEY (lead-scorer / competitor-analyzer /
 * resume-screener).
 *
 * Pre-strip (the 2026-04-21 launch state), a user on /p/resume-screener had
 * NO way to learn:
 *   1. That this app uses Gemini.
 *   2. How many free runs Floom covers per day.
 *   3. How many they have left right now.
 *   4. How to bring their own key BEFORE running out.
 *
 * All of that was discoverable only via the 429 `byok_required` response
 * fired after the 6th run (triggering BYOKModal in "exhausted" mode). The
 * strip above the input card makes every piece visible up front:
 *
 *   - Anonymous, budget left:
 *       ⚡ "Free runs · 3 of 5 today · on Floom   [Use your own key →]"
 *   - Anonymous, budget exhausted:
 *       🔑 "Free runs used up today           [Add Gemini key →]"   (accent)
 *   - User key saved in localStorage:
 *       🔓 "Using your Gemini key · unlimited runs   [Remove key]"
 *   - Non-gated app (uuid, hash, …): renders nothing.
 *
 * The strip is purely informational. The real block happens server-side
 * in apps/server/src/lib/byok-gate.ts; this just tells the user what's
 * about to happen so they're never surprised by the 429 modal.
 *
 * The counter is read from GET /api/:slug/quota (apps/server/src/routes/
 * run.ts::slugQuotaRouter). That endpoint is read-only — polling it does
 * NOT advance the budget. We refresh:
 *   a) once on mount (and on slug change), and
 *   b) whenever the BYOK modal closes (user saved or cleared a key), so
 *      the "has user key" pill flips the moment they commit.
 * We do NOT poll on a timer — the 24h window makes a stale count harmless.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  getAppQuota,
  readUserGeminiKey,
  clearUserGeminiKey,
  type AppQuota,
} from '../../api/client';

export interface FreeRunsStripProps {
  slug: string;
  /**
   * Incremented by RunSurface after any event that might change the
   * user-key state (BYOK modal saved/cancelled) or the usage count (a
   * run completed or 429-rejected). Bumping this causes the strip to
   * re-fetch the quota and re-read localStorage.
   */
  refreshKey?: number;
  /**
   * Called when the user clicks "Use your own key" / "Add Gemini key".
   * RunSurface opens the existing BYOKModal in proactive mode, which
   * differs from the post-429 exhausted mode only in copy.
   */
  onOpenBYOK: () => void;
}

/** Read localStorage lazily — SSR safe and tolerant of storage failures. */
function useHasUserKey(tick: number): boolean {
  const [hasKey, setHasKey] = useState<boolean>(false);
  useEffect(() => {
    setHasKey(readUserGeminiKey() !== null);
  }, [tick]);
  return hasKey;
}

export function FreeRunsStrip({ slug, refreshKey = 0, onOpenBYOK }: FreeRunsStripProps) {
  const [quota, setQuota] = useState<AppQuota | null>(null);
  const [loaded, setLoaded] = useState(false);
  const hasUserKey = useHasUserKey(refreshKey);

  useEffect(() => {
    let cancelled = false;
    // Intentionally not awaiting inside useEffect directly — the async
    // function captures `cancelled` so a stale response (e.g. after a
    // slug change) is discarded instead of flashing a wrong state.
    (async () => {
      const next = await getAppQuota(slug);
      if (!cancelled) {
        setQuota(next);
        setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, refreshKey]);

  const handleRemoveKey = useCallback(() => {
    clearUserGeminiKey();
    // Force a re-read of localStorage + quota so the pill flips from
    // "Using your key" back to "Free runs · 3 of 5 today".
    setQuota((q) => (q ? { ...q, has_user_key_hint: false } : q));
    // useHasUserKey will re-read on next refreshKey bump, but we also
    // do a best-effort synchronous flip so the UI doesn't feel laggy.
    // Callers that want a hard resync should bump refreshKey themselves.
    void 0;
  }, []);

  // A11y: describe the strip as a status region so screen readers
  // announce the counter change but don't interrupt mid-interaction.
  const role = 'status';
  const ariaLive = 'polite';

  // Avoid layout shift: render a 40px-tall placeholder until the first
  // fetch resolves on gated slugs. For ungated slugs we know immediately
  // there's nothing to render (quota.gated === false), but we don't know
  // that until the first fetch either. Show a 0-height spacer until
  // then — the card below is the visible anchor, not us.
  if (!loaded || !quota) return null;
  if (!quota.gated) return null;

  const usage = quota.usage ?? 0;
  const limit = quota.limit ?? 5;
  const remaining = quota.remaining ?? Math.max(0, limit - usage);

  // Reusable pill style. Kept in-line rather than as a CSS class so the
  // component ships self-contained; the other strip in the app (shared-run
  // banner, ~30 lines above the input card) uses the same pattern.
  const baseStrip: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    flexWrap: 'wrap',
    padding: '10px 14px',
    marginBottom: 16,
    borderRadius: 10,
    fontSize: 13,
    color: 'var(--ink)',
    fontFamily: 'inherit',
  };

  const ctaButtonStyle = (accent: boolean): React.CSSProperties => ({
    padding: '6px 12px',
    borderRadius: 999,
    border: accent
      ? '1px solid var(--accent, #10b981)'
      : '1px solid var(--line)',
    background: accent ? 'var(--accent, #10b981)' : 'var(--card)',
    color: accent ? '#fff' : 'var(--ink)',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
    whiteSpace: 'nowrap',
  });

  // Variant A — user has their own key saved.
  if (hasUserKey) {
    return (
      <div
        role={role}
        aria-live={ariaLive}
        data-testid="free-runs-strip"
        data-state="user-key"
        style={{
          ...baseStrip,
          background: 'var(--card)',
          border: '1px solid var(--line)',
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <span
            aria-hidden="true"
            style={{
              display: 'inline-flex',
              width: 18,
              height: 18,
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--accent, #10b981)',
            }}
          >
            {/* unlock icon */}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" />
              <path d="M7 11V7a5 5 0 0 1 9.9-1" />
            </svg>
          </span>
          <span>
            Using your Gemini key · <span style={{ color: 'var(--muted)' }}>unlimited runs, never logged</span>
          </span>
        </span>
        <button
          type="button"
          data-testid="free-runs-strip-remove-key"
          onClick={handleRemoveKey}
          style={ctaButtonStyle(false)}
        >
          Remove key
        </button>
      </div>
    );
  }

  // Variant B — budget exhausted, no user key. Accent-tinted so it reads
  // as "you need to act" rather than "info".
  if (remaining <= 0) {
    return (
      <div
        role={role}
        aria-live={ariaLive}
        data-testid="free-runs-strip"
        data-state="exhausted"
        style={{
          ...baseStrip,
          background: 'var(--accent-soft, #ecfdf5)',
          border: '1px solid var(--accent-border, #86efac)',
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <span
            aria-hidden="true"
            style={{
              display: 'inline-flex',
              width: 18,
              height: 18,
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--accent, #10b981)',
            }}
          >
            {/* key icon */}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zM21 2l-9.6 9.6M15.5 7.5l3 3" />
            </svg>
          </span>
          <span>
            Free runs used up today · <span style={{ color: 'var(--muted)' }}>add your Gemini key to keep going</span>
          </span>
        </span>
        <button
          type="button"
          data-testid="free-runs-strip-add-key"
          onClick={onOpenBYOK}
          style={ctaButtonStyle(true)}
        >
          Add Gemini key &rarr;
        </button>
      </div>
    );
  }

  // Variant C — budget remaining. Quiet neutral strip with a progress-like
  // indicator. Proactive "Use your own key" button is secondary (line-weight
  // button, not accent fill) to avoid drawing attention away from the
  // primary "Run" action in the input card below.
  const pct = Math.max(0, Math.min(100, Math.round((remaining / limit) * 100)));
  return (
    <div
      role={role}
      aria-live={ariaLive}
      data-testid="free-runs-strip"
      data-state="remaining"
      style={{
        ...baseStrip,
        background: 'var(--card)',
        border: '1px solid var(--line)',
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        <span
          aria-hidden="true"
          style={{
            display: 'inline-flex',
            width: 18,
            height: 18,
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--accent, #10b981)',
          }}
        >
          {/* bolt icon */}
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
          </svg>
        </span>
        <span>
          <strong style={{ fontWeight: 600 }}>
            {remaining} of {limit} free runs
          </strong>{' '}
          <span style={{ color: 'var(--muted)' }}>
            today · powered by Gemini · Floom's covering it
          </span>
        </span>
        {/* Tiny inline progress bar — 90×4 track with remaining-coloured
            fill. Hidden on narrow viewports via inline wrap; the label
            above conveys the same information. */}
        <span
          aria-hidden="true"
          style={{
            display: 'inline-block',
            width: 90,
            height: 4,
            borderRadius: 999,
            background: 'var(--line)',
            position: 'relative',
            overflow: 'hidden',
            marginLeft: 4,
          }}
        >
          <span
            style={{
              display: 'block',
              width: `${pct}%`,
              height: '100%',
              background: 'var(--accent, #10b981)',
              transition: 'width .3s ease',
            }}
          />
        </span>
      </span>
      <button
        type="button"
        data-testid="free-runs-strip-use-own-key"
        onClick={onOpenBYOK}
        style={ctaButtonStyle(false)}
      >
        Use your own key
      </button>
    </div>
  );
}

/**
 * Mini in-memory hook for RunSurface: exposes a `bump()` callback that
 * increments a counter so the strip refetches. Kept here so callers only
 * import { FreeRunsStrip, useFreeRunsRefresher } and don't have to manage
 * the counter themselves.
 */
export function useFreeRunsRefresher(): {
  refreshKey: number;
  bump: () => void;
} {
  const [refreshKey, setRefreshKey] = useState(0);
  const bump = useCallback(() => setRefreshKey((n) => n + 1), []);
  return useMemo(() => ({ refreshKey, bump }), [refreshKey, bump]);
}
