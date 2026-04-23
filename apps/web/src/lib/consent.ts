// Cookie consent storage. Single source of truth for read/write/subscribe.
// Used by `CookieBanner` (UI), `lib/sentry.ts` (gate), and `lib/posthog.ts`
// (gate). Kept tiny and SSR-safe so `initBrowserSentry` / `initPostHog` can
// be called from `main.tsx` at boot without pulling in React.
//
// Storage layout (kept in sync, both written together in `setConsent`):
//   - localStorage["floom.cookie-consent"] = "essential" | "all"
//   - document.cookie  "floom.cookie-consent" = same value, 1 year, Lax
//
// We mirror to a first-party cookie so any future server-rendered routes
// can respect the choice without waiting for client JS.

export type Consent = 'essential' | 'all';

export const CONSENT_STORAGE_KEY = 'floom.cookie-consent';
export const CONSENT_COOKIE_NAME = 'floom.cookie-consent';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

const CHANGE_EVENT = 'floom:cookie-consent-change';

/**
 * Read the current consent choice. Returns `null` when the user hasn't
 * chosen yet (banner should show). SSR-safe.
 */
export function getConsent(): Consent | null {
  if (typeof window === 'undefined') return null;
  try {
    const v = window.localStorage.getItem(CONSENT_STORAGE_KEY);
    if (v === 'essential' || v === 'all') return v;
  } catch {
    // localStorage can throw in private mode; fall through to cookie.
  }
  if (typeof document !== 'undefined') {
    const match = document.cookie.match(
      new RegExp('(?:^|; )' + CONSENT_COOKIE_NAME.replace(/\./g, '\\.') + '=([^;]+)'),
    );
    if (match && (match[1] === 'essential' || match[1] === 'all')) {
      return match[1] as Consent;
    }
  }
  return null;
}

/**
 * Persist the user's consent choice. Writes both localStorage and a
 * first-party cookie under the same key, then fires a change event so any
 * subscribed telemetry modules can light up / tear down in the same
 * session without a page reload.
 */
export function setConsent(choice: Consent): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, choice);
  } catch {
    // ignore (private mode)
  }
  try {
    const secure = window.location.protocol === 'https:' ? '; Secure' : '';
    document.cookie =
      `${CONSENT_COOKIE_NAME}=${choice}; Max-Age=${COOKIE_MAX_AGE}; Path=/; SameSite=Lax${secure}`;
  } catch {
    // ignore
  }
  try {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: choice }));
  } catch {
    // ignore (older browsers)
  }
}

/**
 * Subscribe to consent changes. Returns an unsubscribe function. Useful for
 * components that want to react to a user toggling their choice mid-session.
 */
export function subscribeConsent(fn: (next: Consent | null) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = () => fn(getConsent());
  window.addEventListener(CHANGE_EVENT, handler);
  return () => window.removeEventListener(CHANGE_EVENT, handler);
}
