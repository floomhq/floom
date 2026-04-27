// MVP stub: /settings/byok-keys → redirect for launch.

import { Navigate } from 'react-router-dom';

export function SettingsByokKeysPage() {
  return <Navigate to="/me/agent-keys" replace />;
}

export function MeSecretsPage() {
  return <SettingsByokKeysPage />;
}
