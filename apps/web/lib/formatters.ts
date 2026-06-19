// Shared formatters for dates, durations, and trigger labels.
// Use these everywhere instead of inlining Date math or toLocaleString.

const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "-";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return formatRelativeFuture(iso);
  if (ms < MIN_MS) return `${Math.max(1, Math.round(ms / 1000))}s ago`;
  if (ms < HOUR_MS) return `${Math.round(ms / MIN_MS)}min ago`;
  if (ms < DAY_MS) return `${Math.round(ms / HOUR_MS)}h ago`;
  return `${Math.round(ms / DAY_MS)}d ago`;
}

export function formatRelativeFuture(iso: string | null | undefined): string {
  if (!iso) return "-";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "now";
  if (ms < MIN_MS) return `in ${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < HOUR_MS) return `in ${Math.round(ms / MIN_MS)}min`;
  if (ms < DAY_MS) return `in ${Math.round(ms / HOUR_MS)}h`;
  return `in ${Math.round(ms / DAY_MS)}d`;
}

// #1130: cap duration display — anything beyond 24h is a zombie/timed-out run.
const ZOMBIE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export function formatDuration(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return "-";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms >= ZOMBIE_THRESHOLD_MS) return "Timed out";
  return `${Math.round(ms / 1000 / 60)}min`;
}

export function formatTimeOfDay(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatAbsolute(iso: string | null | undefined): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleString();
}

// Friendlier variant used on worker cards and connection cards: "never" /
// "just now" / "X min ago" / "Xh ago" / "Xd ago". Prefer formatRelative()
// in dense log/runs UIs where shorter is better.
export function formatRelativeTime(value?: string | null): string {
  if (!value) return "never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / MIN_MS);
  if (diffMin < 2) return "just now";
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.floor(diffH / 24);
  return `${diffD}d ago`;
}

export function formatLogTime(iso: string): string {
  return new Date(iso).toLocaleTimeString();
}
