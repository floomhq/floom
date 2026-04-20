// /studio/settings — legacy route. Redirects to /me/settings?tab=studio
// so all settings live in one place. Merged 2026-04-20 (round 2) per the
// adversarial bug hunt: users hit the wrong page when account changes
// live at /me/settings and creator-specific prefs lived here.
//
// The StudioSidebar still links to /studio/settings; this redirect keeps
// that working without touching sidebar code (the nav polish agent owns
// that file). When the sidebar link is updated to point directly at
// /me/settings?tab=studio this file can be removed and the route dropped
// from main.tsx.

import { Navigate } from 'react-router-dom';

export function StudioSettingsPage() {
  return <Navigate to="/me/settings?tab=studio" replace />;
}
