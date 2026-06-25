// Product decision (2026-06-24): clicking "New worker" ANYWHERE drives the
// IN-EMILY worker-creation flow that supersedes the active Emily chat IN PLACE
// — it must NOT navigate to the separate /workers/new page (which mounts a
// second surface beside the docked Emily). Every "New worker" entry point
// funnels through this helper, so it returns the `?create=1` deep link that the
// EmilyDock create effect (components/emily/EmilyChat.tsx) listens for.
//
// The link targets the home route ("/"), where EmilyDock is mounted and
// auto-fullscreens, so the create flow takes over the main area. A primed
// prompt rides along as `?create=1&prime=<text>` (the dock effect reads `prime`
// or `prompt`).
//
// /workers/new is intentionally LEFT reachable as a direct deep-link route — we
// just stop the entry points from forcing it.
export function createWorkerHref(prompt?: string | null): string {
  const base = "/?create=1";
  return prompt ? `${base}&prime=${encodeURIComponent(prompt)}` : base;
}
