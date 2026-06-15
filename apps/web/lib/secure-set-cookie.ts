// #927 — wos_session was forwarded from the backend without the Secure flag.
//
// The backend sets wos_session and the web app forwards that Set-Cookie header
// verbatim (login, setup, proxy). Whatever the backend sends, the cookie that
// reaches the browser must carry Secure: the app is only served over HTTPS and
// the cookie must never be sent on a pre-HSTS plain-HTTP request.

/** All Set-Cookie values of a fetch Response, as individual header values. */
export function getSetCookies(upstream: Response): string[] {
  // getSetCookie() (undici/Node >=18.17) returns the un-merged list; the plain
  // get() fallback can comma-join cookies and is only safe for single cookies.
  const viaApi = upstream.headers.getSetCookie?.();
  if (viaApi && viaApi.length > 0) return viaApi;
  const single = upstream.headers.get("set-cookie");
  return single ? [single] : [];
}

/** True when a response cookie must carry Secure. */
export function secureCookiesForUrl(requestUrl: string): boolean {
  if (process.env.NODE_ENV === "production") return true;
  try {
    return new URL(requestUrl).protocol === "https:";
  } catch {
    return false;
  }
}

/** Appends `; Secure` to any Set-Cookie value that does not already have it. */
export function withSecureFlag(setCookie: string): string {
  if (/(^|;)\s*secure\s*(;|$)/i.test(setCookie)) return setCookie;
  return `${setCookie}; Secure`;
}

/** Forward all upstream Set-Cookie headers onto `headers`, forcing Secure when required. */
export function forwardSecureSetCookies(
  upstream: Response,
  headers: Headers,
  secureCookies = true,
): void {
  for (const cookie of getSetCookies(upstream)) {
    headers.append("set-cookie", secureCookies ? withSecureFlag(cookie) : cookie);
  }
}
