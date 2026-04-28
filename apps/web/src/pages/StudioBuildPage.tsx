// MVP stub: /studio/build → redirect for launch.

import { Navigate } from 'react-router-dom';

export function StudioBuildPage() {
  return <Navigate to="/me/agent-keys" replace />;
}
