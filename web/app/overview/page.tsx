// /overview — alias of the home so old links (and the mobile top-bar logo) keep
// working. Like "/", it is the EXISTING Emily shown FULLSCREEN (the EmilyDock
// detects the route and takes over). Renders the same quiet pane placeholder.
import { HomePane } from "@/components/home/HomePane";

// #945: authenticated, per-user dashboard must not be statically cached.
export const dynamic = "force-dynamic";

export default function OverviewPage() {
  return <HomePane />;
}
