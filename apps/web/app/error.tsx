"use client";

import { useEffect } from "react";
import { safeStorageGet, safeStorageRemove, safeStorageSet } from "@/lib/safe-storage";

// Root error boundary. Catches any unhandled error in the app shell.
//
// The most common case on cold navigation is a ChunkLoadError: the browser has
// a cached HTML page that references chunk hashes from an older Vercel
// deployment. When the new deployment lands, those chunk URLs 404. A hard
// reload fetches the fresh HTML (and its fresh chunk hashes), fixing the issue
// transparently.
//
// For any other error we render a plain retry UI.

const RELOAD_ATTEMPTED_KEY = "chunk-error-reload-attempted";

function isChunkLoadError(error: Error): boolean {
  return (
    error.name === "ChunkLoadError" ||
    /loading chunk/i.test(error.message) ||
    /failed to fetch dynamically imported module/i.test(error.message) ||
    /error loading dynamically imported module/i.test(error.message) ||
    /net::err_aborted 404/i.test(error.message)
  );
}

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    if (!isChunkLoadError(error)) return;

    // Avoid infinite reload loops: only attempt once per session.
    const attempted = safeStorageGet("session", RELOAD_ATTEMPTED_KEY);
    if (!attempted) {
      safeStorageSet("session", RELOAD_ATTEMPTED_KEY, "1");
      window.location.reload();
    }
  }, [error]);

  // Show a minimal retry UI while the reload is in flight, or for non-chunk
  // errors after the user manually clicks retry.
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="max-w-sm space-y-4 text-center">
        <p className="text-sm text-muted-foreground">Something went wrong.</p>
        <button
          type="button"
          onClick={() => {
            safeStorageRemove("session", RELOAD_ATTEMPTED_KEY);
            reset();
          }}
          className="inline-flex h-8 items-center rounded-md [border:var(--bd-card)] bg-card px-4 text-sm font-medium hover:bg-muted transition-colors"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
