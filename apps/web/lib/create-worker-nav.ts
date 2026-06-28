export function createWorkerHref(prompt?: string | null): string {
  const href = "/workers/new";
  const text = (prompt ?? "").trim();
  return text ? `${href}?prompt=${encodeURIComponent(text)}` : href;
}
