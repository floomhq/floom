import { useLocation } from 'react-router-dom';
import { RunRail } from './RunRail';

export function SettingsRail() {
  const location = useLocation();
  return <RunRail key={location.pathname} />;
}
