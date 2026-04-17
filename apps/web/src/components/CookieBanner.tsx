// Cookie consent banner. Non-intrusive, fixed to bottom of viewport.
// - "Accept essential only" and "Accept all" buttons (essential-only is the
//   left/secondary action; we currently set zero non-essential cookies, so
//   both choices lead to the same set today but the choice is recorded).
// - Persists to localStorage AND a first-party cookie so server-rendered
//   pages can also respect the choice if we add any.
// - Hidden once a choice exists. SSR-safe (guards against undefined window).

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

const STORAGE_KEY = 'floom.cookie-consent';
const COOKIE_NAME = 'floom.cookie-consent';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

type Choice = 'essential' | 'all';

function readChoice(): Choice | null {
  if (typeof window === 'undefined') return null;
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v === 'essential' || v === 'all') return v;
  } catch {
    // localStorage can throw in private mode; fall through to cookie.
  }
  if (typeof document !== 'undefined') {
    const match = document.cookie.match(
      new RegExp('(?:^|; )' + COOKIE_NAME.replace(/\./g, '\\.') + '=([^;]+)'),
    );
    if (match && (match[1] === 'essential' || match[1] === 'all')) {
      return match[1] as Choice;
    }
  }
  return null;
}

function writeChoice(choice: Choice) {
  try {
    window.localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    // ignore
  }
  try {
    const secure = window.location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${COOKIE_NAME}=${choice}; Max-Age=${COOKIE_MAX_AGE}; Path=/; SameSite=Lax${secure}`;
  } catch {
    // ignore
  }
}

export function CookieBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (readChoice() === null) setVisible(true);
  }, []);

  if (!visible) return null;

  const accept = (choice: Choice) => {
    writeChoice(choice);
    setVisible(false);
  };

  return (
    <div
      role="dialog"
      aria-live="polite"
      aria-label="Cookie consent"
      style={{
        position: 'fixed',
        left: 16,
        right: 16,
        bottom: 16,
        zIndex: 1000,
        maxWidth: 560,
        margin: '0 auto',
        padding: '14px 16px',
        background: 'var(--card)',
        border: '1px solid var(--line)',
        borderRadius: 12,
        boxShadow: '0 10px 30px rgba(14, 14, 12, 0.12)',
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 12,
        fontSize: 13,
        color: 'var(--ink)',
      }}
    >
      <p style={{ margin: 0, flex: '1 1 260px', lineHeight: 1.5 }}>
        Floom uses strictly necessary cookies to keep you signed in and remember your preferences. See our{' '}
        <Link to="/cookies" style={{ color: 'var(--accent)', textDecoration: 'underline' }}>
          cookie policy
        </Link>
        .
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={() => accept('essential')}
          style={{
            padding: '8px 14px',
            borderRadius: 8,
            border: '1px solid var(--line)',
            background: 'transparent',
            color: 'var(--ink)',
            cursor: 'pointer',
            fontFamily: 'inherit',
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          Essential only
        </button>
        <button
          type="button"
          onClick={() => accept('all')}
          style={{
            padding: '8px 14px',
            borderRadius: 8,
            border: '1px solid var(--accent)',
            background: 'var(--accent)',
            color: '#fff',
            cursor: 'pointer',
            fontFamily: 'inherit',
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          Accept all
        </button>
      </div>
    </div>
  );
}
