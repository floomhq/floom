import { useState } from 'react';
import { Link } from 'react-router-dom';

interface Props {
  onSignIn?: () => void;
}

export function TopBar({ onSignIn }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header className="topbar">
      <div className="topbar-inner">
        <Link to="/" className="brand">
          floom
        </Link>
        {/* Desktop nav */}
        <nav className="topbar-links topbar-links-desktop">
          <button
            type="button"
            className="topbar-nav-btn"
            data-testid="topbar-public-apps"
            onClick={() => {
              window.dispatchEvent(new CustomEvent('floom:pill', { detail: { pill: 'public-apps' } }));
            }}
          >
            public apps
          </button>
          <a
            href="https://github.com/floomhq/floom"
            target="_blank"
            rel="noreferrer"
            style={{ display: 'flex', alignItems: 'center', gap: 5 }}
          >
            <svg width={14} height={14} viewBox="0 0 24 24" fill="currentColor">
              <use href="#icon-github" />
            </svg>
            github
          </a>
          <button
            type="button"
            className="btn-signin"
            onClick={onSignIn}
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
        <div className="topbar-mobile-menu" role="menu">
          <button
            type="button"
            className="topbar-mobile-link"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              window.dispatchEvent(new CustomEvent('floom:pill', { detail: { pill: 'public-apps' } }));
            }}
          >
            Public apps
          </button>
          <a
            href="https://github.com/floomhq/floom"
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
              onSignIn?.();
            }}
          >
            Sign in
          </button>
        </div>
      )}
    </header>
  );
}
