"use client";

import { useEffect, useRef, useState } from "react";
import { useIsRestoring } from "@tanstack/react-query";
import { FloomMark } from "@/components/layout/sidebar";
import { hasPersistedCache } from "@/lib/query/persist";

// Cold-start branded boot splash.
//
// Goal: on a TRUE cold start (first ever load, no persisted cache yet) show a
// brief on-brand Floom mark instead of a bare skeleton. On a WARM start (the
// localStorage cache is present) the persisted cache hydrates near-instantly,
// so we must NOT show the splash and MUST NOT delay the user.
//
// How the gate decides:
//   - hasPersistedCache() is read ONCE at mount (synchronous localStorage peek).
//     If a usable cache exists → warm start → never render the splash.
//   - useIsRestoring() is true while PersistQueryClientProvider rehydrates the
//     cache. The first paint after a cold start sits inside this window with no
//     data to show; that is exactly when the splash earns its keep.
//   - To avoid a sub-frame flicker, once the splash is shown on a cold start we
//     keep it up for a short MIN_VISIBLE_MS, then drop it the instant restore is
//     settled. Total cold-start cost is a fraction of a second.
//
// Restrained per design system: centered mark on the cool bg, one subtle pulse,
// the "Floom" wordmark. No spinner, no emoji, no borders, no round chrome.

const MIN_VISIBLE_MS = 450;

export function BootSplash() {
  const isRestoring = useIsRestoring();
  // Warm vs cold decided once, before paint. Warm start → splash is inert.
  const [isColdStart] = useState(() => !hasPersistedCache());
  const [visible, setVisible] = useState(isColdStart);
  const shownAt = useRef<number | null>(null);

  useEffect(() => {
    if (!isColdStart) {
      setVisible(false);
      return;
    }
    // Record when the splash first became visible (client-only, in an effect so
    // render stays pure).
    if (shownAt.current === null) shownAt.current = Date.now();
    if (isRestoring) return; // still booting — keep the splash up

    // Restore settled: hide, but honor the minimum visible window so the brand
    // mark reads as intentional rather than a flash.
    const elapsed = Date.now() - shownAt.current;
    const remaining = Math.max(0, MIN_VISIBLE_MS - elapsed);
    const t = setTimeout(() => setVisible(false), remaining);
    return () => clearTimeout(t);
  }, [isColdStart, isRestoring]);

  if (!visible) return null;

  return (
    <div
      aria-hidden="true"
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-3 bg-[var(--bg-app)]"
    >
      <div className="floom-boot-pulse">
        <FloomMark size={48} />
      </div>
      <span className="text-sm font-medium tracking-tight text-foreground/70">Floom</span>
    </div>
  );
}
