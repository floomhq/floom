import { Link } from 'react-router-dom';
import { Logo } from '../Logo';

interface PublicNavProps {
  /**
   * Landing shows a single "Sign in" link on the right.
   * Apps shows "Build" + "Your runs" ghost links on the right.
   * This is the v15 public nav — deliberately bare. Signed-in
   * product surfaces keep using `TopBar`.
   */
  variant?: 'landing' | 'apps';
}

export function PublicNav({ variant = 'landing' }: PublicNavProps) {
  return (
    <nav
      data-testid="public-nav"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '18px 40px',
        borderBottom: '1px solid var(--line)',
        background: 'transparent',
      }}
    >
      <Link
        to="/"
        aria-label="Floom home"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          color: 'var(--ink)',
          textDecoration: 'none',
        }}
      >
        <Logo variant="glow" size={28} />
        <span style={{ fontWeight: 600, fontSize: 16, letterSpacing: '-0.01em' }}>floom</span>
      </Link>

      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        {variant === 'landing' ? (
          <Link to="/login" data-testid="public-nav-signin" className="public-nav-link">
            Sign in
          </Link>
        ) : (
          <>
            <Link to="/build" data-testid="public-nav-build" className="public-nav-link">
              Build
            </Link>
            <Link to="/me" data-testid="public-nav-your-runs" className="public-nav-link">
              Your runs
            </Link>
          </>
        )}
      </div>
    </nav>
  );
}
