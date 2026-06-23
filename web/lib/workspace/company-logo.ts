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

/** Favicon/logo URL for a workspace or company name.
 *
 *  Uses DuckDuckGo's favicon proxy (`https://icons.duckduckgo.com/ip3/<domain>.ico`).
 *  This service returns a real HTTP 404 when no logo exists, so the browser's
 *  `<img onError>` handler fires and the Avatar component can cleanly fall back to
 *  the deterministic generated mark. Google's s2/favicons was replaced because it
 *  returns a generic globe placeholder with HTTP 200 on misses, making it impossible
 *  to detect a miss client-side.
 *
 *  For plain workspace names (e.g. "reltix", "Heidi Health") we guess `<slug>.com`.
 *  Most company-named workspaces have a corresponding .com — if the guess is wrong,
 *  DuckDuckGo returns 404 → `onError` → generated mark. This is strictly better than
 *  the previous behaviour that returned null for every non-dotted name (showing only
 *  generated marks even for real companies).
 *
 *  The `size` parameter is kept for API compatibility but DuckDuckGo always returns
 *  a fixed-size icon; callers may ignore it.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function companyLogoUrl(company: string, _size = 128): string | null {
  const domain = guessDomain(company);
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
