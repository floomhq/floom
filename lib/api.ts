export const API_BASE = process.env.NEXT_PUBLIC_WORKEROS_API_BASE ?? "https://workeros-api.floom.dev";

export const OAUTH_LOGIN_URL = (next = "/") =>
  `${API_BASE}/auth/login?provider=google&next=${encodeURIComponent(next)}`;

export const OAUTH_LOGIN_URL_GITHUB = (next = "/") =>
  `${API_BASE}/auth/login?provider=github&next=${encodeURIComponent(next)}`;
