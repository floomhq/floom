// MVP stub: /studio/:slug/renderer → redirect for launch.

import { Navigate } from 'react-router-dom';

export function StudioAppRendererPage() {
  return <Navigate to="/me/agent-keys" replace />;
}
