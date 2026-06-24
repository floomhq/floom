export const API_BASE = process.env.NEXT_PUBLIC_WORKEROS_API_BASE ?? "https://workeros-api.floom.dev";

const OAUTH_PROXY_BASE = process.env.NEXT_PUBLIC_API_PROXY_BASE?.replace(/\/$/, "");

function oauthLoginPath(provider: "google" | "github", next: string): string {
  const params = new URLSearchParams({ provider, next });
  if (OAUTH_PROXY_BASE) {
    return `${OAUTH_PROXY_BASE}/auth/login?${params.toString()}`;
  }
  return `${API_BASE}/auth/login?${params.toString()}`;
}

export const OAUTH_LOGIN_URL = (next = "/") => oauthLoginPath("google", next);

export const OAUTH_LOGIN_URL_GITHUB = (next = "/") => oauthLoginPath("github", next);
