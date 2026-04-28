// MVP stub: /run/runs/:id → redirect to agent-keys for launch.

import { Navigate } from 'react-router-dom';

export function MeRunDetailPage() {
  return <Navigate to="/me/agent-keys" replace />;
}
