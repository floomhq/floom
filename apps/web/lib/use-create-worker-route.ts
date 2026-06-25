"use client";

/**
 * Product decision (2026-06-24): "New worker" now drives the IN-EMILY create
 * flow that supersedes the active Emily chat IN PLACE (see EmilyDock in
 * components/emily/EmilyChat.tsx — the `?create=1` deep-link effect). This hook
 * USED to intercept `/?create=1` and forward it to the separate /workers/new
 * page, which defeated the in-place flow. It is now a deliberate no-op so
 * `?create=1` reaches EmilyDock's effect instead of being redirected away.
 *
 * Kept (rather than deleted) so existing imports/tests have a stable surface and
 * the contract — "do NOT redirect ?create=1 to /workers/new" — stays covered.
 * /workers/new remains reachable as a direct deep-link route.
 */
export function useCreateWorkerLegacyRedirect(): void {
  // Intentionally does nothing: ?create=1 is handled in place by EmilyDock.
}
