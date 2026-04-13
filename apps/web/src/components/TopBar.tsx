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
          <Link to="/apps" className="topbar-nav-btn" data-testid="topbar-apps">
            apps
          </Link>
          <Link to="/chat" className="topbar-nav-btn" data-testid="topbar-chat">
            chat
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
            onClick={onSignIn}
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
        <div className="topbar-mobile-menu" role="menu">
          <Link
            to="/apps"
            className="topbar-mobile-link"
            role="menuitem"
            onClick={() => setMenuOpen(false)}
          >
            Apps
          </Link>
          <Link
            to="/chat"
            className="topbar-mobile-link"
            role="menuitem"
            onClick={() => setMenuOpen(false)}
          >
            Chat
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
