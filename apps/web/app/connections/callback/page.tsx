"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";

function CallbackInner() {
  const router = useRouter();
  const params = useSearchParams();

  useEffect(() => {
    // The backend's /connections/callback already handles updating the DB
    // and redirects to /connections?connected=1.
    // This page is a fallback in case the user manually lands here.
    const connected = params.get("connected");
    if (connected === "1") {
      router.replace("/connections");
    } else {
      // Forward all params to the API callback endpoint, then redirect
      const connectionId = params.get("connection_id") || params.get("connectionId") || "";
      const status = params.get("status") || "";
      const qs = new URLSearchParams();
      if (connectionId) qs.set("connection_id", connectionId);
      if (status) qs.set("status", status);
      // The API proxy will handle DB update + redirect
      window.location.href = `/api/proxy/connections/callback?${qs.toString()}`;
    }
  }, [params, router]);

  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="text-center space-y-2">
        <div className="w-8 h-8 rounded-full border-2 border-[#111] border-t-transparent animate-spin mx-auto" />
        <p className="text-sm text-[#666]">Finalizing connection...</p>
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
