// Home ("/") — the EXISTING Emily shown FULLSCREEN (Federico 2026-06-19).
//
// The home is NOT a separate composer. The EmilyDock (mounted in AppShell)
// detects the home route, forces Emily into TRUE fullscreen (the page pane
// hides, the sidebar stays), and renders the home greeting + lean pulse + pills
// in Emily's OWN empty state — seeding Emily's real composer. This page only
// renders a quiet placeholder for the pane (hidden once Emily goes fullscreen).
import { HomePane } from "@/components/home/HomePane";

// #945: authenticated, per-user dashboard must not be statically cached.
export const dynamic = "force-dynamic";

export default function HomePage() {
  return <HomePane />;
}
