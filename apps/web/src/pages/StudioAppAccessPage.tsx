// MVP stub: /studio/:slug/access → redirect for launch.

import { Navigate } from 'react-router-dom';

export function StudioAppAccessPage() {
  return <Navigate to="/me/agent-keys" replace />;
}
