"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";

function CallbackInner() {
  const router = useRouter();
  const params = useSearchParams();

  useEffect(() => {
    // If this page was opened as a popup from the inline OAuth flow,
    // notify the opener so the poll can resolve immediately.
    if (window.opener && typeof window.opener.postMessage === "function") {
      // Extract app slug from URL search params if present
      const appSlug = params.get("app") || params.get("app_name") || "";
      window.opener.postMessage(
        { type: "oauth-connected", appSlug },
        window.location.origin
      );
    }

    const connected = params.get("connected");
    if (connected === "1") {
      // Opened in popup: postMessage already sent above, close popup.
      // Opened in main window: redirect to connections page.
      if (window.opener) {
        window.close();
      } else {
        router.replace("/connections");
      }
    } else {
      // Forward all params to the API callback endpoint, then redirect
      const connectionId = params.get("connection_id") || params.get("connectionId") || "";
      const status = params.get("status") || "";
      const qs = new URLSearchParams();
      if (connectionId) qs.set("connection_id", connectionId);
      if (status) qs.set("status", status);
      // The API proxy will handle DB update + redirect back here with ?connected=1
      window.location.href = `/api/proxy/connections/callback?${qs.toString()}`;
    }
  }, [params, router]);

  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="text-center space-y-2">
        <div className="w-8 h-8 rounded-full border-2 border-foreground border-t-transparent animate-spin mx-auto" />
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
