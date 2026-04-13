import { useState } from 'react';
import { Link } from 'react-router-dom';
import { FloomWordmark } from './Logo';

interface Props {
  onSignIn?: () => void;
}

function SignInModal({ onClose }: { onClose: () => void }) {
  return (
    <>
      <div
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 200 }}
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-label="Sign in coming soon"
        data-testid="signin-modal"
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          zIndex: 201,
          background: 'var(--card)',
          border: '1px solid var(--line)',
          borderRadius: 16,
          padding: '32px',
          maxWidth: 400,
          width: '90vw',
        }}
      >
        <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.07em', margin: '0 0 8px' }}>
          Coming in v1.1
        </p>
        <h2 style={{ fontSize: 20, fontWeight: 700, margin: '0 0 10px', color: 'var(--ink)' }}>
          GitHub OAuth shipping v1.1.
        </h2>
        <p style={{ fontSize: 14, color: 'var(--muted)', margin: '0 0 16px', lineHeight: 1.6 }}>
          Watch{' '}
          <a
            href="https://github.com/floomhq/floom-monorepo"
            target="_blank"
            rel="noreferrer"
            style={{ color: 'var(--accent)', textDecoration: 'none' }}
          >
            floomhq/floom-monorepo
          </a>{' '}
          on GitHub to be notified when it ships.
        </p>
        <button
          type="button"
          className="btn-primary"
          style={{ fontSize: 14, padding: '8px 20px' }}
          onClick={onClose}
        >
          Got it
        </button>
        <button
          type="button"
          onClick={onClose}
          style={{ position: 'absolute', top: 14, right: 16, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: 18, fontFamily: 'inherit' }}
          aria-label="Close"
        >
          ×
        </button>
      </div>
    </>
  );
}

export function TopBar({ onSignIn: _onSignIn }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [signInModalOpen, setSignInModalOpen] = useState(false);

  const handleSignIn = () => {
    setSignInModalOpen(true);
  };

  return (
    <header className="topbar">
      <div className="topbar-inner">
        <Link to="/" className="brand" style={{ display: 'flex', alignItems: 'center', textDecoration: 'none', color: 'var(--ink)' }}>
          <FloomWordmark size={24} />
        </Link>
        {/* Desktop nav — hidden on mobile via CSS; aria-hidden added for screen reader cleanliness */}
        <nav className="topbar-links topbar-links-desktop" aria-label="Desktop navigation">
          <Link to="/apps" className="topbar-nav-btn" data-testid="topbar-apps">
            apps
          </Link>
          <Link to="/protocol" className="topbar-nav-btn" data-testid="topbar-protocol">
            protocol
          </Link>
          <a
            href="https://github.com/floomhq/floom-monorepo"
            target="_blank"
            rel="noreferrer"
            style={{ display: 'flex', alignItems: 'center', gap: 5 }}
            data-testid="topbar-github"
          >
            <svg width={14} height={14} viewBox="0 0 24 24" fill="currentColor">
              <use href="#icon-github" />
            </svg>
            github
          </a>
          <button
            type="button"
            className="btn-signin"
            onClick={handleSignIn}
            data-testid="topbar-signin"
            style={{ cursor: 'pointer', background: 'var(--card)', fontFamily: 'inherit' }}
          >
            Sign in
          </button>
        </nav>
        {/* Mobile hamburger */}
        <button
          type="button"
          className="hamburger topbar-hamburger"
          data-testid="hamburger"
          aria-label="Open menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
        >
          <span />
          <span />
          <span />
        </button>
      </div>
      {/* Mobile dropdown */}
      {menuOpen && (
        <div className="topbar-mobile-menu" role="menu" aria-label="Mobile navigation">
          <Link
            to="/apps"
            className="topbar-mobile-link"
            role="menuitem"
            onClick={() => setMenuOpen(false)}
          >
            Apps
          </Link>
          <Link
            to="/protocol"
            className="topbar-mobile-link"
            role="menuitem"
            onClick={() => setMenuOpen(false)}
          >
            Protocol
          </Link>
          <a
            href="https://github.com/floomhq/floom-monorepo"
            target="_blank"
            rel="noreferrer"
            className="topbar-mobile-link"
            role="menuitem"
            onClick={() => setMenuOpen(false)}
          >
            GitHub
          </a>
          <button
            type="button"
            className="topbar-mobile-link"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              handleSignIn();
            }}
          >
            Sign in
          </button>
        </div>
      )}
      {signInModalOpen && <SignInModal onClose={() => setSignInModalOpen(false)} />}
    </header>
  );
}
