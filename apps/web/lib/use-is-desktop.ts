"use client";

import { useEffect, useState } from "react";

// Shared desktop/mobile breakpoint hook. Defaults to `true` (desktop) so SSR and
// the first client render agree (no hydration mismatch); corrected on mount once
// `window.matchMedia` is available. Used by AppShell (to mount the Emily dock vs
// the mobile bottom-sheet) and by HomePane (to choose the mobile home pane).
export function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(true);
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
