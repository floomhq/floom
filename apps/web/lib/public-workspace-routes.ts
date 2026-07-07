// Matches ONLY the single-segment public workspace profile path: /@{handle}.
// This is also the auth-gate / noindex predicate in proxy.ts, so it must stay
// scoped to the profile page and never widen to cover other /@ routes.
export function isPublicWorkspaceProfilePath(pathname: string): boolean {
  return /^\/@[^/]+\/?$/.test(pathname);
}

// Matches the two-segment L4 worker permalink path: /@{handle}/{workerSlug}
// (see app/[handle]/[workerSlug]/page.tsx). Kept as a SEPARATE predicate from
// isPublicWorkspaceProfilePath on purpose: that function also drives proxy.ts's
// noindex marking, and the permalink page is deliberately indexable (no
// noindex — see the page's own doc comment), so it must not be folded in
// there. This export exists solely for AppShell's standalone-chrome check
// (#2211 shipped the permalink page and route, but never taught AppShell to
// render it standalone, so it silently mounted inside the full authenticated
// dashboard shell — Sidebar/EmilyDock/CommandPalette/DeepLinkRouter/
// TermsAcceptanceGate — around a page never designed to coexist with them).
//
// Decodes the pathname first: the page's own permalinkUrls() builds the
// canonical/OG URL with encodeURIComponent(`@${handle}`), which escapes '@' to
// '%40', and Next's usePathname() does not decode that back. A literal-'@'-only
// regex would match every real observed crash (PostHog: $current_url was a
// literal "/app/@handle/slug" on every hit) but silently miss the canonical
// link a crawler or unfurl bot follows. decodeURIComponent is wrapped because
// a malformed percent-sequence in an attacker-controlled path must not throw.
export function isPublicWorkerPermalinkPath(pathname: string): boolean {
  return /^\/@[^/]+\/[^/]+\/?$/.test(safeDecodePathname(pathname));
}

function safeDecodePathname(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}
