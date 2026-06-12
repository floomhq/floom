"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { Loader2 } from "lucide-react";

function CallbackInner() {
  const router = useRouter();
  const params = useSearchParams();

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
      // Opened in popup: close it. Opened in main window: go to connections.
      if (window.opener) {
        window.close();
      } else {
        router.replace("/connections");
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
      const qs = new URLSearchParams();
      if (connectionId) qs.set("connection_id", connectionId);
      if (status) qs.set("status", status);

      const callbackPath = `/api/proxy/connections/callback?${qs.toString()}`;

      function navigateAfterCallback(finalUrl?: string) {
        let dest = "/connections";
        if (finalUrl) {
          try {
            // Extract the ?connected=1&app=...&connection_id=... params that
            // the backend embeds in the redirect target (used by ConnectionsClient
            // to show a toast and highlight the new row — M58).
            const parsed = new URL(finalUrl, window.location.origin);
            if (parsed.pathname === "/connections") {
              const feedbackQs = new URLSearchParams();
              const c = parsed.searchParams.get("connected");
              if (c) feedbackQs.set("connected", c);
              const app = parsed.searchParams.get("app");
              if (app) feedbackQs.set("app", app);
              const cid = parsed.searchParams.get("connection_id");
              if (cid) feedbackQs.set("connection_id", cid);
              const qStr = feedbackQs.toString();
              dest = qStr ? `/connections?${qStr}` : "/connections";
            }
          } catch {
            // Malformed URL — fall back to plain /connections.
          }
        }
        if (window.opener) {
          window.close();
        } else {
          router.replace(dest);
        }
      }

      fetch(callbackPath, {
        // redirect:"follow" so the browser carries the session cookie through
        // same-origin hops. We only need res.url; the body is discarded.
        redirect: "follow",
        credentials: "same-origin",
      })
        .then((res) => navigateAfterCallback(res.url))
        .catch(() => navigateAfterCallback());
    }
  }, [params, router]);

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
