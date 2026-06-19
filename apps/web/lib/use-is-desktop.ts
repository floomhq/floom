"use client";

import { useEffect, useState } from "react";

// Shared desktop/mobile breakpoint hook. Defaults to `false` (mobile) so a phone
// NEVER gets the desktop branch — not even for a single frame. SSR and the first
// client render both produce the mobile branch (no hydration mismatch); the
// effect then syncs to the real viewport on mount, flipping desktop viewports to
// `true`. Desktop users see a one-frame mobile flash before the effect runs,
// which is acceptable. Used by AppShell (to mount the Emily dock vs the mobile
// bottom-sheet — the only surface carrying the Ask-Emily FAB) and by HomePane.
//
// Why `false` not `true`: with a `true` default, if the post-mount sync ever
// fails to flip a phone to `false`, AppShell mounts the desktop EmilyDock (which
// is `hidden md:flex`) and NEVER mounts EmilyMobileSheet, leaving Emily
// unreachable on mobile (#1544). Defaulting to `false` makes the mobile sheet the
// guaranteed baseline.
export function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(min-width: 768px)");
    const sync = () => setIsDesktop(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return isDesktop;
}
