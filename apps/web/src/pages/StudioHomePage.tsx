// MVP stub: /studio/overview and /studio/apps → redirect for launch.

import { Navigate } from 'react-router-dom';

export function StudioHomePage() {
  return <Navigate to="/me/agent-keys" replace />;
}

export function StudioAppsPage() {
  return <Navigate to="/me/agent-keys" replace />;
}
