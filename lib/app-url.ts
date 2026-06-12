export const DEFAULT_APP_URL = "";

type QueryValue = string | number | boolean | null | undefined;

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

export function appBaseUrl(): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (!configured) return DEFAULT_APP_URL;
  try {
    const url = new URL(configured);
    if (url.hostname === "workers.floom.dev") return DEFAULT_APP_URL;
  } catch {
    // Relative values are allowed; they keep Cloud links on the current origin.
  }
  return stripTrailingSlashes(configured);
}

export function stripLegacyAppPrefix(pathname: string): string {
  if (pathname === "/app") return "/";
  if (pathname.startsWith("/app/")) return pathname.slice(4);
  return pathname || "/";
}

export function appUrl(path = "/", query?: Record<string, QueryValue>): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const base = appBaseUrl();
  if (!base) {
    const params = new URLSearchParams();
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== null && value !== undefined) {
          params.set(key, String(value));
        }
      }
    }
    const qs = params.toString();
    return `${normalizedPath}${qs ? `?${qs}` : ""}`;
  }
  const url = new URL(normalizedPath, `${base}/`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== null && value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}
