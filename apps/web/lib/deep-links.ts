// Deep links (APP-UI-V4-SPEC §2): a URL hash like `#workers` sets the initial
// page. The pages are real Next routes, so a recognized page hash on load maps
// to its route and the shell navigates there once on mount.
//
// Only the seven known top-level page keywords are recognized; anything else
// (e.g. SlackConnect's hash query-state, Emily's in-thread anchors) returns null
// and is left untouched.

const HASH_TO_ROUTE: Record<string, string> = {
  overview: "/overview",
  workers: "/workers",
  brain: "/brain",
  runs: "/runs",
  approvals: "/approvals",
  connections: "/connections",
  settings: "/settings",
};

/**
 * Map a location hash to a top-level app route, or null if it isn't a known
 * page deep link. Tolerates the leading `#`, sub-paths (`#workers/123`),
 * query suffixes (`#runs?tag=x`) and surrounding whitespace/case.
 */
export function pageForHash(hash: string | null | undefined): string | null {
  if (!hash) return null;
  const trimmed = hash.trim();
  const raw = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
  // first segment before a path / query / fragment separator
  const keyword = raw.split(/[/?#:]/)[0].trim().toLowerCase();
  if (!keyword) return null;
  return HASH_TO_ROUTE[keyword] ?? null;
}

/**
 * Given the current pathname and a hash, return the route to navigate to for an
 * initial deep link, or null if no navigation is needed (unknown hash, or the
 * hash already matches the page we're on).
 */
export function deepLinkTarget(
  pathname: string,
  hash: string | null | undefined
): string | null {
  const target = pageForHash(hash);
  if (!target) return null;
  if (pathname === target || pathname.startsWith(`${target}/`)) return null;
  return target;
}
