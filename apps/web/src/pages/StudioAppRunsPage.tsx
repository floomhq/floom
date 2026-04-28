// MVP stub: /studio/:slug/runs → redirect for launch.

import { Navigate } from 'react-router-dom';

export function StudioAppRunsPage() {
  return <Navigate to="/me/agent-keys" replace />;
}
