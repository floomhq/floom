// MVP stub: /settings/general → redirect for launch.

import { Navigate } from 'react-router-dom';

export function AccountSettingsPage() {
  return <Navigate to="/me/agent-keys" replace />;
}

export function MeSettingsPage() {
  return <AccountSettingsPage />;
}
