export function createWorkerHref(prompt?: string | null): string {
  const href = "/workers/new";
  return prompt ? `${href}?prompt=${encodeURIComponent(prompt)}` : href;
}
