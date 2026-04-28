// MVP stub: /studio/:slug/triggers → redirect for launch.

import { Navigate } from 'react-router-dom';

export function StudioAppTriggersPage() {
  return <Navigate to="/me/agent-keys" replace />;
}

export function StudioTriggersTab() {
  return <StudioAppTriggersPage />;
}
