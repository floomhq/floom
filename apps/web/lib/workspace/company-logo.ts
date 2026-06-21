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

/** Favicon/logo URL for a company domain input (Google's favicon service, no API key).
 *
 *  Only returns a URL when the input looks like a real company domain — i.e. when
 *  it already contains a dot (e.g. "acme.com", "https://acme.io/about"). A plain
 *  slug like "depontefede" or "content-pipeline" is NOT a company domain: the guessed
 *  `slug.com` would almost always resolve to a generic globe favicon from the service,
 *  making workspace avatars inconsistent (globe in some places, gradient squircle in
 *  others). Return null in that case so the caller falls back to the deterministic
 *  gradient squircle.
 */
export function companyLogoUrl(company: string, size = 128): string | null {
  const v = company.trim();
  if (!v) return null;
  // Only fetch a favicon when the input is dot-qualified (an explicit domain or URL).
  // A plain word without a dot is guessed as `<slug>.com` but almost never has a
  // real logo — the favicon service returns a generic globe, which looks wrong.
  const hasDot = v.includes(".");
  if (!hasDot) return null;
  const domain = guessDomain(v);
  return domain ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=${size}` : null;
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
