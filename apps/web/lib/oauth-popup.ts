/**
 * OAuth popup helper for inline connection flow.
 *
 * Opens the OAuth URL in a popup window, then resolves when the connection
 * becomes active. Two detection strategies run in parallel:
 *
 *  1. postMessage: the /connections/callback page sends a message to
 *     window.opener after a successful OAuth return. Resolves immediately.
 *
 *  2. Polling fallback: GET /connections every 2s for up to 60s, looking
 *     for a newly-active connection for the given app slug.
 */

import { api } from "@/lib/api";

const POPUP_WIDTH = 600;
const POPUP_HEIGHT = 700;
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 60_000;
const POLL_MAX_ATTEMPTS = 30;

export type OAuthPopupResult = "connected" | "timeout" | "closed";

export interface OAuthPopupOptions {
  /** Composio OAuth URL returned by POST /connections */
  oauthUrl: string;
  /** App slug (e.g. "gmail") to look for in the connections list */
  appSlug: string;
  /** Called each time a poll detects the connection is active */
  onConnected?: () => void;
}

function openCenteredPopup(url: string): Window | null {
  const left = Math.round(window.screenX + (window.outerWidth - POPUP_WIDTH) / 2);
  const top = Math.round(window.screenY + (window.outerHeight - POPUP_HEIGHT) / 2);
  // "popup=yes" is the modern hint that tells the browser to treat this as a
  // focused popup window rather than a background tab. Without it some browsers
  // open the URL behind the current window.
  return window.open(
    url,
    `oauth-${Date.now()}`,
    `popup=yes,width=${POPUP_WIDTH},height=${POPUP_HEIGHT},left=${left},top=${top},toolbar=no,menubar=no,scrollbars=yes,resizable=yes,noopener,noreferrer`
  );
}

export function openOAuthPopup({
  oauthUrl,
  appSlug,
  onConnected,
}: OAuthPopupOptions): Promise<OAuthPopupResult> {
  return new Promise((resolve) => {
    const popup = openCenteredPopup(oauthUrl);
    if (!popup) {
      // Browser blocked the popup — fall back to full-page redirect so the
      // user can complete OAuth. The callback page will post a message back or
      // the polling will pick it up on return.
      window.location.href = oauthUrl;
      // We never resolve here; the page navigates away.
      return;
    }
    try {
      popup.opener = null;
    } catch {
      // Some browsers expose a readonly opener on cross-origin/noopener windows.
    }

    let done = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let checkClosedTimer: ReturnType<typeof setInterval> | null = null;

    function finish(result: OAuthPopupResult) {
      if (done) return;
      done = true;
      if (pollTimer) clearInterval(pollTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (checkClosedTimer) clearInterval(checkClosedTimer);
      window.removeEventListener("message", onMessage);
      if (result === "connected") {
        onConnected?.();
      }
      resolve(result);
    }

    // Strategy 1: postMessage from /connections/callback
    function onMessage(event: MessageEvent) {
      // Accept messages from same origin only
      if (event.origin !== window.location.origin) return;
      if (
        event.data &&
        typeof event.data === "object" &&
        event.data.type === "oauth-connected" &&
        (!event.data.appSlug || event.data.appSlug === appSlug)
      ) {
        finish("connected");
      }
    }
    window.addEventListener("message", onMessage);

    // Strategy 2: poll GET /connections every 2s, up to POLL_MAX_ATTEMPTS
    const normalizedSlug = appSlug.toLowerCase();
    let pollAttempts = 0;
    pollTimer = setInterval(async () => {
      if (done) return;
      pollAttempts++;
      if (pollAttempts > POLL_MAX_ATTEMPTS) {
        // Exceeded cap — stop polling; timeout timer will resolve if still open
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;
        return;
      }
      try {
        const connections = await api.connections.list();
        const active = connections.find(
          (c) =>
            c.app_name.toLowerCase() === normalizedSlug && c.status === "active"
        );
        if (active) {
          finish("connected");
        }
      } catch {
        // ignore poll errors, keep trying
      }
    }, POLL_INTERVAL_MS);

    // Timeout after 60s
    timeoutTimer = setTimeout(() => {
      finish("timeout");
    }, POLL_TIMEOUT_MS);

    // Detect popup closed by user without completing OAuth
    checkClosedTimer = setInterval(() => {
      if (popup.closed) {
        // Give polling one extra chance before declaring closed
        setTimeout(async () => {
          if (done) return;
          try {
            const connections = await api.connections.list();
            const active = connections.find(
              (c) =>
                c.app_name.toLowerCase() === normalizedSlug && c.status === "active"
            );
            if (active) {
              finish("connected");
            } else {
              finish("closed");
            }
          } catch {
            finish("closed");
          }
        }, 1500);
      }
    }, 1000);
  });
}
