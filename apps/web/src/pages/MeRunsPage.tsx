// MVP stub: /run/runs → redirect to agent-keys for launch.

import { Navigate } from 'react-router-dom';

export function MeRunsPage() {
  return <Navigate to="/me/agent-keys" replace />;
}
