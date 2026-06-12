export const DEFAULT_APP_URL = "https://workers.floom.dev";

type QueryValue = string | number | boolean | null | undefined;

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

export function appBaseUrl(): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  return stripTrailingSlashes(configured || DEFAULT_APP_URL);
}

export function stripLegacyAppPrefix(pathname: string): string {
  if (pathname === "/app") return "/";
  if (pathname.startsWith("/app/")) return pathname.slice(4);
  return pathname || "/";
}

export function appUrl(path = "/", query?: Record<string, QueryValue>): string {
  const url = new URL(path.startsWith("/") ? path : `/${path}`, `${appBaseUrl()}/`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== null && value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}
