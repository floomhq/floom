// §5a2: the new-workspace modal has ONE company field — typing it derives a
// logo (favicon service) and prefills the workspace name. Pure helpers so the
// derivation is unit-tested independently of the modal.

/** Derive a domain from a company input. A dotted input is used verbatim;
 *  otherwise we guess `<slug>.com`. Returns null for empty input. */
export function guessDomain(company: string): string | null {
  const v = company.trim().toLowerCase();
  if (!v) return null;
  if (v.includes(".")) {
    // Strip protocol / path if pasted as a URL.
    return v.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  }
  const slug = v.replace(/[^a-z0-9]+/g, "");
  return slug ? `${slug}.com` : null;
}

/** Favicon/logo URL for a workspace or company.
 *
 *  Returns a URL ONLY when the input already contains a dot — i.e. it is a
 *  real domain (e.g. "acme.com", "https://acme.io/about"). Plain display names
 *  like "Nova Search" or "content-pipeline" return null so the Avatar component
 *  renders the clean generated mark instead of attempting a favicon fetch.
 *
 *  Rule: NO favicon guessing from workspace names. A workspace logo is shown
 *  only when the workspace has a real stored domain value passed as input.
 *  Otherwise the caller must pass null/undefined and let Avatar generate.
 *
 *  Uses DuckDuckGo's favicon proxy (`https://icons.duckduckgo.com/ip3/<domain>.ico`).
 *  The `size` parameter is kept for API compatibility; DuckDuckGo returns a
 *  fixed-size icon and ignores it.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function companyLogoUrl(company: string, _size = 128): string | null {
  const v = company.trim();
  // Only proceed when the input is already a dot-qualified domain or URL.
  // Plain names (no dot) return null — no slug guessing.
  if (!v || !v.includes(".")) return null;
  const domain = v.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
  return domain ? `https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico` : null;
}

/** Prefilled, human workspace name from the company input (TLD stripped, title-cased). */
export function prefillWorkspaceName(company: string): string {
  const base = company.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "").split(".")[0] || "";
  return base
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
