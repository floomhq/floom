// Server-safe bridge for emitting client INTENT events from `lib/api.ts`.
//
// `lib/api.ts` is NOT a "use client" module and is imported by server
// components, so it must not statically pull in posthog-js (a browser-only
// SDK). This module is the thin seam: `captureIntentEvent` no-ops on the
// server (typeof window === "undefined") and lazily loads the real client
// posthog wrapper only in the browser.
//
// INTENT events only. Outcomes (run_started / worker_created /
// connection_added) are emitted server-side — never call this with those names.

export function captureIntentEvent(
  eventName: string,
  properties: Record<string, unknown> = {}
): void {
  if (typeof window === "undefined") return;
  // Dynamic import keeps posthog-js out of any server bundle that imports
  // lib/api.ts; the chunk only loads in the browser.
  void import("@/lib/posthog")
    .then(({ capturePostHogEvent }) => {
      capturePostHogEvent(eventName, properties);
    })
    .catch(() => {
      // Telemetry must never throw into a product action.
    });
}
