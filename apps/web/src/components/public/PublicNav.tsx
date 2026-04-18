import { Link } from 'react-router-dom';
import { Logo } from '../Logo';
import { useSession } from '../../hooks/useSession';

interface PublicNavProps {
  /**
   * Landing shows a single "Sign in" link on the right.
   * Apps shows "Build" + "Your runs" ghost links on the right for signed-in
   * users; anonymous visitors get "Build" + "Sign in" so the nav never
   * advertises a destination ("Your runs") that can only redirect back to
   * /login. See 2026-04-18 consumer UX audit finding #4.
   * This is the v15 public nav — deliberately bare. Signed-in
   * product surfaces keep using `TopBar`.
   */
  variant?: 'landing' | 'apps';
}

export function PublicNav({ variant = 'landing' }: PublicNavProps) {
  const { isAuthenticated } = useSession();
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
        // No explicit aria-label: the visible "floom" text inside the link
        // is already the accessible name. Adding aria-label="Floom home"
        // triggered Lighthouse label-content-name-mismatch because the
        // visible text ("floom") did not start with the label text.
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
            {isAuthenticated ? (
              <Link to="/me" data-testid="public-nav-your-runs" className="public-nav-link">
                Your runs
              </Link>
            ) : (
              <Link to="/login" data-testid="public-nav-signin" className="public-nav-link">
                Sign in
              </Link>
            )}
          </>
        )}
      </div>
    </nav>
  );
}
