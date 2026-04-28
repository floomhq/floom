// MVP stub: /run/apps → redirect to agent-keys for launch.

import { Navigate } from 'react-router-dom';

export function MeAppsPage() {
  return <Navigate to="/me/agent-keys" replace />;
}
