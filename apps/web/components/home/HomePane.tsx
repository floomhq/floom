"use client";

// Home main-pane placeholder (Federico 2026-06-19).
//
// The home ("/" and "/overview") IS the EXISTING Emily shown FULLSCREEN — the
// EmilyDock (always mounted in AppShell) detects the home route, forces Emily
// into fullscreen, and renders the home greeting + pulse + pills in ITS empty
// state. There is NO separate main-pane composer.
//
// When Emily is fullscreen the AppShell hides this pane entirely, so this
// component only shows for the brief moment before the fullscreen effect runs
// (and as a graceful fallback if fullscreen is somehow off). It is intentionally
// minimal — a quiet centered mark — never a second composer.
import { EmilyRadarMark } from "./EmilyRadarMark";

export function HomePane() {
  return (
    <div className="flex h-full w-full items-center justify-center" aria-hidden="true">
      <EmilyRadarMark size={46} variant="ink" />
    </div>
  );
}
