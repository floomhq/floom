import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { LAUNCH_APPS } from '../../data/demoData';

// Dense strip of the 15 launch apps. Shown directly under the hero so the
// reader sees actual product, not abstract claims, in the first scroll.

export function LaunchAppsStrip() {
  return (
    <div className="launch-strip">
      <div className="launch-strip-head">
        <p className="label-mono">Live right now</p>
        <Link to="/apps" className="launch-strip-all">
          All 15 apps <ArrowRight size={11} />
        </Link>
      </div>
      <div className="launch-strip-grid">
        {LAUNCH_APPS.map((a) => (
          <Link key={a.slug} to={`/p/${a.slug}`} className="launch-cell">
            <div className="launch-cell-name">{a.name}</div>
            <div className="launch-cell-tagline">{a.tagline}</div>
            <div className="launch-cell-tag">{a.category}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}
