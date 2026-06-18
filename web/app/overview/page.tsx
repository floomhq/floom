"use client";

// S45: overview page — AlertsBell in top-right, OverviewDashboard below.
// #1292: the alerts bell is now global (rendered in AppShell, top-right of the
// content pane on every page), so the overview page no longer mounts its own
// bell or bubbles attention items up to it.
import { OverviewDashboard } from "@/components/overview/OverviewDashboard";

export default function OverviewPage() {
  return <OverviewDashboard />;
}
