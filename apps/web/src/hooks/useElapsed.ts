import { useEffect, useState } from 'react';

/**
 * Fix 2 (2026-04-20): tick an elapsed-ms counter at 1Hz.
 *
 * Used by the run progress UI so users see time actually moving on
 * long AI apps (20–40s typical) rather than a dead spinner. When
 * `startedAt` is null the hook returns null — the caller decides
 * whether to show a fallback (e.g. "Starting…") in that case.
 *
 * A 1s tick is cheap (1 render/sec while a run is in flight) and lines
 * up with the mm:ss display in `formatElapsed()` below so we don't
 * re-render more than we need to.
 */
export function useElapsed(startedAt: Date | number | null): number | null {
  const startMs =
    startedAt == null
      ? null
      : typeof startedAt === 'number'
        ? startedAt
        : startedAt.getTime();
  const [elapsed, setElapsed] = useState<number | null>(() =>
    startMs == null ? null : Math.max(0, Date.now() - startMs),
  );

  useEffect(() => {
    if (startMs == null) {
      setElapsed(null);
      return;
    }
    // Tick immediately so the first render shows a real value, then
    // every 1s until the start time changes.
    setElapsed(Math.max(0, Date.now() - startMs));
    const id = window.setInterval(() => {
      setElapsed(Math.max(0, Date.now() - startMs));
    }, 1000);
    return () => window.clearInterval(id);
  }, [startMs]);

  return elapsed;
}

/**
 * mm:ss for runs under an hour; otherwise "Nm Ns". Matches the
 * JobProgress duration format so the two progress UIs agree.
 */
export function formatElapsed(ms: number): string {
  if (ms < 1000) return '0:00';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `0:${String(s).padStart(2, '0')}`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}:${String(rem).padStart(2, '0')}`;
  return `${m}m ${rem}s`;
}

/**
 * "~30s typical" style hint. Picks a human-readable unit and avoids
 * zero-seconds for tiny values.
 */
export function formatEstimate(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `~${s}s typical`;
  const m = Math.round(ms / 60000);
  return `~${m}m typical`;
}
