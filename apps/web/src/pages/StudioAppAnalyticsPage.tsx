// MVP stub: /studio/:slug/analytics → redirect for launch.

import { Navigate } from 'react-router-dom';

export function StudioAppAnalyticsPage() {
  return <Navigate to="/me/agent-keys" replace />;
}
