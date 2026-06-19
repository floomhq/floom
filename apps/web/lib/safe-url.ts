// #914 — href sanitization for untrusted markdown (worker output, Emily chat).
//
// react-markdown's default urlTransform already neutralizes most dangerous
// protocols, but every custom `a` component that forwards `href` must not rely
// on that implicit behavior (it can be disabled by passing urlTransform, and
// non-markdown call sites get no protection at all). This is the explicit,
// testable allowlist.

const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

/**
 * Returns the href unchanged when it uses an allowlisted protocol or is a
 * relative/fragment/query URL; returns undefined for anything dangerous
 * (javascript:, data:, vbscript:, file:, ...) so the anchor renders inert.
 */
export function sanitizeHref(href: string | undefined): string | undefined {
  if (!href) return undefined;
  // Strip control/whitespace chars browsers ignore inside protocol names
  // ("java\nscript:" parses as javascript: in some engines).
  const cleaned = href.replace(/[\s\x00-\x1F\x7F]+/g, "");
  if (cleaned === "") return undefined;
  // Protocol-relative URLs (`//host/path`) resolve to https: with the base
  // below, but they are still external navigations. Reject them before URL
  // parsing so markdown renderers never mistake them for single-slash internal
  // app links.
  if (cleaned.startsWith("//")) return undefined;

  let protocol: string;
  try {
    // Base required so relative URLs parse; their protocol resolves to the base.
    protocol = new URL(cleaned, "https://relative.invalid").protocol;
  } catch {
    return undefined;
  }

  if (SAFE_PROTOCOLS.has(protocol.toLowerCase())) return href;
  return undefined;
}
