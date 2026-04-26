const TOKENLESS_AUTH_PATHS = new Set([
  '/auth/sign-in/email',
  '/auth/sign-up/email',
  '/auth/get-session',
  '/auth/change-password',
]);

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function shouldRedactAuthResponse(req: Request): boolean {
  try {
    const url = new URL(req.url);
    return TOKENLESS_AUTH_PATHS.has(url.pathname);
  } catch {
    return false;
  }
}

export function redactAuthTokens(payload: unknown): { payload: unknown; changed: boolean } {
  if (!isObjectRecord(payload)) return { payload, changed: false };

  let changed = false;
  const next: Record<string, unknown> = { ...payload };

  if ('token' in next) {
    delete next.token;
    changed = true;
  }

  if (isObjectRecord(next.session) && 'token' in next.session) {
    const session = { ...next.session };
    delete session.token;
    next.session = session;
    changed = true;
  }

  return { payload: next, changed };
}

export async function sanitizeAuthResponse(req: Request, res: Response): Promise<Response> {
  if (!shouldRedactAuthResponse(req)) return res;

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) return res;

  const text = await res.clone().text().catch(() => '');
  if (!text) return res;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return res;
  }

  const { payload, changed } = redactAuthTokens(parsed);
  if (!changed) return res;

  const body = JSON.stringify(payload);
  const headers = new Headers(res.headers);
  // Recompute rather than delete — some reverse proxies (nginx keep-alive,
  // undici connection pools) use Content-Length for framing. Deleting it
  // forces chunked transfer and can cause proxy logs to show wrong sizes.
  headers.set('content-length', String(Buffer.byteLength(body, 'utf-8')));
  return new Response(body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

export const __test__ = {
  redactAuthTokens,
  shouldRedactAuthResponse,
};
