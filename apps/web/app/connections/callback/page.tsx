"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { refetchConnectionReads } from "@/lib/query/connection-status";

// #1209/#1206: refetch the same connection-status read path the
// /connections/redirect poll refetches. This page is the OTHER live
// completion point (the OAuth provider's actual redirect_uri, set server-side
// to {base}/connections/callback), and it lands in its own window/tab with
// the SAME localStorage-persisted TanStack cache, so it needs the same fix,
// not a per-surface patch. The shared helper includes inactive persisted reads.

function CallbackInner() {
  const router = useRouter();
  const params = useSearchParams();
  const queryClient = useQueryClient();

  useEffect(() => {
    // If this page was opened as a popup from the inline OAuth flow,
    // notify the opener so the poll can resolve immediately.
    if (window.opener && typeof window.opener.postMessage === "function") {
      const appSlug = params.get("app") || params.get("app_name") || "";
      window.opener.postMessage(
        { type: "oauth-connected", appSlug },
        window.location.origin
      );
    }

    const connected = params.get("connected");
    if (connected === "1") {
      // Opened in popup: close it (the opener window has its own cache and
      // handles invalidation via its own postMessage/poll path, see
      // lib/oauth-popup.ts). Opened in main window: this tab is where the
      // user actually lands, so invalidate this tab's cache before navigating.
      if (window.opener) {
        window.close();
      } else {
        void refetchConnectionReads(queryClient);
        const qs = new URLSearchParams();
        const cid = params.get("connection_id");
        const sel = params.get("sel") || cid;
        if (connected) qs.set("connected", connected);
        const app = params.get("app");
        if (app) qs.set("app", app);
        if (cid) qs.set("connection_id", cid);
        if (sel) qs.set("sel", sel);
        const qStr = qs.toString();
        router.replace(qStr ? `/connections?${qStr}` : "/connections");
      }
    } else {
      // M57 FIX: trigger the backend DB-update via fetch, then navigate
      // client-side instead of following the backend's HTTP redirect.
      //
      // Root cause of M57: the old code used window.location.href to navigate
      // to /api/proxy/connections/callback. The proxy returned the backend's
      // 307 redirect.  In the server-side proxy fetch (with redirect:"manual"),
      // the 307 is forwarded to the browser correctly — but in certain browser/
      // network configurations (e.g. the proxy previously using redirect:"follow",
      // before the backend bugpass) the redirect was followed server-side without
      // the user's session cookie, causing middleware to redirect to /login.
      //
      // Fix: fire the callback endpoint as a browser fetch() with redirect:"follow".
      // The browser carries the session cookie on same-origin requests and follows
      // redirects with the cookie intact. We extract the final URL from res.url
      // (which contains the ?connected=1&app=...&connection_id=... feedback params
      // that ConnectionsClient uses to show a toast and highlight the new row).
      // We then navigate client-side via router.replace — the session is
      // unconditionally preserved because no HTTP redirect is involved.
      const connectionId =
        params.get("connection_id") ||
        params.get("connectionId") ||
        params.get("connected_account_id") ||
        params.get("connectedAccountId") ||
        params.get("id") ||
        "";
      const status = params.get("status") || "";
      const state = params.get("state") || "";
      const qs = new URLSearchParams();
      if (connectionId) qs.set("connection_id", connectionId);
      if (status) qs.set("status", status);
      if (state) qs.set("state", state);

      const callbackPath = `/api/proxy/connections/callback?${qs.toString()}`;

      function navigateAfterCallback(finalUrl?: string, fetchFailed?: boolean) {
        let dest = "/connections";
        if (finalUrl) {
          try {
            // Extract the ?connected=1&app=...&connection_id=... (or
            // ?connected=0&error=...) params that the backend embeds in the
            // redirect target (used by ConnectionsCollection to show a toast
            // and highlight the new row — M58). `error` was previously
            // dropped here, so a FAILED connection (backend deletes the
            // orphaned row and redirects with connected=0&error=oauth_failed)
            // landed on a bare /connections list with zero explanation.
            const parsed = new URL(finalUrl, window.location.origin);
            if (parsed.pathname === "/connections") {
              const feedbackQs = new URLSearchParams();
              const c = parsed.searchParams.get("connected");
              if (c) feedbackQs.set("connected", c);
              const app = parsed.searchParams.get("app");
              if (app) feedbackQs.set("app", app);
              const err = parsed.searchParams.get("error");
              if (err) feedbackQs.set("error", err);
              const cid = parsed.searchParams.get("connection_id");
              if (cid) feedbackQs.set("connection_id", cid);
              const sel = parsed.searchParams.get("sel") || cid;
              if (sel) feedbackQs.set("sel", sel);
              const qStr = feedbackQs.toString();
              dest = qStr ? `/connections?${qStr}` : "/connections";
            }
          } catch {
            // Malformed URL — fall back to a visible network-error state
            // below rather than a silent plain /connections.
          }
        }
        if (fetchFailed && dest === "/connections") {
          // The proxy fetch itself failed (offline, timeout, 5xx with no
          // body) — we never even reached a backend redirect, so there is no
          // `connected=`/`error=` to forward. Surface a generic failure
          // instead of silently landing on the list as if nothing happened.
          dest = "/connections?connected=0&error=network";
        }
        if (window.opener) {
          window.close();
        } else {
          // Invalidate before navigating whether the backend reported success
          // or failure: on success the destination must show the fresh
          // connected state; on failure the query simply refetches and
          // confirms the (unchanged) not-connected state. Either way this tab
          // never renders a stale pre-callback read.
          void refetchConnectionReads(queryClient);
          router.replace(dest);
        }
      }

      fetch(callbackPath, {
        // redirect:"follow" so the browser carries the session cookie through
        // same-origin hops. We only need res.url; the body is discarded.
        redirect: "follow",
        credentials: "same-origin",
      })
        .then((res) => {
          // fetch() only rejects on network-level failures — a raw 5xx from
          // the backend with no redirect resolves normally with !res.ok, and
          // res.url would still be the /api/proxy/... request URL (not
          // /connections), so the pathname check above already falls through
          // to the default dest. Treat a non-OK final response the same as a
          // caught fetch failure instead of silently landing on the list.
          navigateAfterCallback(res.url, !res.ok);
        })
        .catch(() => navigateAfterCallback(undefined, true));
    }
  }, [params, router, queryClient]);

  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="text-center space-y-2">
        <Loader2 className="mx-auto size-8 animate-spin text-foreground" />
        <p className="text-sm text-muted-foreground">Finalizing connection...</p>
      </div>
    </div>
  );
}

export default function ConnectionsCallbackPage() {
  return (
    <Suspense>
      <CallbackInner />
    </Suspense>
  );
}
