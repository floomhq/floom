import { OverviewDashboard } from "@/components/overview/OverviewDashboard";

// S39 overview redesign (ported from engine). The dashboard fetches
// /system/overview client-side through the /app/api/proxy proxy.
export default function OverviewPage() {
  return <OverviewDashboard />;
}
