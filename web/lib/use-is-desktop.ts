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
// Breakpoint is 1024px (Tailwind `lg`), NOT 768px (#1544 tablet fix). At 768px
// the three-column desktop shell (sidebar ~228px + content + Emily dock ~330px)
// crushes the middle pane to ~210px so worker cards render behind the always-open
// dock. The tablet range (768–1023) therefore uses the MOBILE shell: full-width
// content + collapsed sidebar drawer + the Ask-Emily FAB/bottom-sheet. The CSS
// shell coupling (sidebar `lg:flex`/`lg:hidden`, body `lg:flex-row`, dock widths,
// alerts bell) flips at the same `lg` so JS and CSS stay in lockstep. True desktop
// (≥1024, ample at sidebar 228 + dock 330 + content ≥466) is unchanged. This also
// matches the contexts editor, which already uses 1024 as its desktop boundary.
//
// Why `false` not `true`: with a `true` default, if the post-mount sync ever
// fails to flip a phone to `false`, AppShell mounts the desktop EmilyDock (which
// is `hidden lg:flex`) and NEVER mounts EmilyMobileSheet, leaving Emily
// unreachable on mobile (#1544). Defaulting to `false` makes the mobile sheet the
// guaranteed baseline.
export function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(min-width: 1024px)");
    const sync = () => setIsDesktop(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return isDesktop;
}
