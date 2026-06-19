"use client";

// Home main-pane (Federico 2026-06-18/19).
//
// By default the home ("/" and "/overview") IS the EXISTING Emily shown
// FULLSCREEN — the EmilyDock (always mounted in AppShell) detects the home
// route, forces Emily into fullscreen, and renders the home greeting + pulse +
// pills in ITS empty state. While Emily is fullscreen the AppShell hides this
// pane entirely, so the quiet centered mark below only shows for the brief
// moment before the fullscreen effect runs.
//
// Round-09 batch2: the home fullscreen Emily is now COLLAPSIBLE. When the user
// collapses Emily on home, Emily docks to the right rail and this pane becomes
// visible again — and it must show the user's WORKERS list (not a blank
// placeholder, not the deleted Overview). We reuse the SAME WorkersCollection
// that /workers renders (no duplication); it fetches the list client-side.
import { useEmilyFullscreen } from "@/components/emily/emily-fullscreen";
import WorkersCollection from "@/app/workers/WorkersCollection";
import { EmilyRadarMark } from "./EmilyRadarMark";

export function HomePane() {
  const { fullscreen } = useEmilyFullscreen();

  // Emily collapsed on home → show the Workers list (the same one /workers uses).
  if (!fullscreen) {
    return <WorkersCollection initialWorkers={[]} />;
  }

  // Emily fullscreen (the default) → AppShell hides this pane; render a quiet
  // centered mark for the brief pre-fullscreen frame / graceful fallback.
  return (
    <div className="flex h-full w-full items-center justify-center" aria-hidden="true">
      <EmilyRadarMark size={46} variant="ink" />
    </div>
  );
}
