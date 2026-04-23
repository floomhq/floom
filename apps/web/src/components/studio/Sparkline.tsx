// Per-card 7-bar sparkline for /studio · My apps.
//
// Wireframe: `/var/www/wireframes-floom/v17/studio-my-apps.html` .sparkline
// Rule: N inline divs with height = count / max_count. Zero days get
// min-height:2px so the bar is always visible (otherwise the axis reads
// as "6 days" instead of 7). Days with count === max_count flip to the
// `peak` treatment (accent foreground) to match the wireframe.
//
// Data: loaded per-card from GET /api/hub/:slug/runs-by-day?days=7 (see
// api/client.ts#getAppRunsByDay). The endpoint is creator-only and
// zero-fills the window server-side so this component just renders.
//
// Why inline divs not SVG: 7 bars, no axis, no tooltip — the DOM cost
// is identical and staying on plain divs lets the Studio stylesheet's
// existing `--accent` tokens flow through without a render tree.

import { useEffect, useState } from 'react';
import { getAppRunsByDay } from '../../api/client';

export interface SparklineProps {
  slug: string;
  /** Number of days to fetch. Defaults to 7, matching the wireframe. */
  days?: number;
  /** Pass to fade the whole sparkline (e.g. draft / never-run apps). */
  muted?: boolean;
}

export function Sparkline({ slug, days = 7, muted = false }: SparklineProps) {
  // null === still loading, [] === loaded but empty, Array === loaded with data
  const [series, setSeries] = useState<Array<{ date: string; count: number }> | null>(null);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getAppRunsByDay(slug, days)
      .then((res) => {
        if (cancelled) return;
        setSeries(res.days);
      })
      .catch(() => {
        if (cancelled) return;
        setErrored(true);
        // Fall back to an empty series so the card still lays out.
        setSeries(Array.from({ length: days }, () => ({ date: '', count: 0 })));
      });
    return () => {
      cancelled = true;
    };
  }, [slug, days]);

  // Pre-load skeleton: render N flat bars so there's no layout shift
  // between loading and loaded state.
  const bars = series ?? Array.from({ length: days }, () => ({ date: '', count: 0 }));
  const maxCount = bars.reduce((m, b) => (b.count > m ? b.count : m), 0);

  return (
    <div
      data-testid={`sparkline-${slug}`}
      aria-label={
        errored
          ? `Sparkline unavailable for ${slug}`
          : `Daily run counts for ${slug}: ${bars.map((b) => b.count).join(', ')}`
      }
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        gap: 2,
        height: 24,
        opacity: muted ? 0.5 : 1,
      }}
    >
      {bars.map((b, i) => {
        // Height in percent of the bar slot. When every day is zero
        // (fresh app), all bars flatten to the min — the floor at 2px
        // keeps them visible without faking signal. When there's
        // activity we normalize against the max and give zero days the
        // same floor so the shape reads honestly.
        const ratio = maxCount > 0 ? b.count / maxCount : 0;
        const heightPct = ratio === 0 ? 0 : Math.max(ratio * 100, 12);
        // peak bar = the max-count day(s). Matches .sparkline div.peak
        // in the wireframe (accent fg vs accent-bg for the non-peak bars).
        const isPeak = maxCount > 0 && b.count === maxCount;
        return (
          <div
            key={`${b.date || 'empty'}-${i}`}
            data-count={b.count}
            data-date={b.date || undefined}
            style={{
              flex: 1,
              minHeight: 2,
              height: `${heightPct}%`,
              background: isPeak ? 'var(--accent, #059669)' : 'var(--accent-bg, #ecfdf5)',
              borderRadius: 2,
              transition: 'height 160ms ease',
            }}
          />
        );
      })}
    </div>
  );
}
