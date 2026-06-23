export function createWorkerHref(prime?: string | null): string {
  const href = "/?create=1";
  return prime ? `${href}&prime=${encodeURIComponent(prime)}` : href;
}
