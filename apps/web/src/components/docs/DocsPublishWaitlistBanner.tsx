import { useCallback, useMemo, useState } from 'react';
import { readDeployEnabled } from '../../lib/flags';

const STORAGE_KEY = 'floom:docs-publish-waitlist-banner-dismissed';

function readDismissed(): boolean {
  if (typeof sessionStorage === 'undefined') return false;
  try {
    return sessionStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Dismissible docs-only banner when publishing is waitlist-gated on floom.dev.
 * Dismissal persists for the browser tab session (sessionStorage).
 */
export function DocsPublishWaitlistBanner() {
  const deployEnabled = useMemo(() => readDeployEnabled(), []);
  const [dismissed, setDismissed] = useState(readDismissed);

  const onDismiss = useCallback(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, '1');
    } catch {
      /* ignore quota / private mode */
    }
    setDismissed(true);
  }, []);

  if (deployEnabled || dismissed) {
    return null;
  }

  return (
    <div
      role="status"
      data-testid="docs-publish-waitlist-banner"
      style={{
        margin: '0 auto',
        maxWidth: 1260,
        padding: '12px 48px 0',
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 12,
          padding: '12px 14px',
          background: 'var(--card)',
          border: '1px solid var(--line)',
          borderRadius: 10,
          fontSize: 13,
          lineHeight: 1.55,
          color: 'var(--ink)',
        }}
      >
        <p style={{ margin: 0, flex: 1, minWidth: 0 }}>
          Publishing is currently waitlist-only on floom.dev.{' '}
          <a
            href="https://github.com/floomhq/floom"
            target="_blank"
            rel="noreferrer"
            style={{ color: 'var(--accent)', fontWeight: 600 }}
          >
            Self-host
          </a>{' '}
          for unrestricted access.
        </p>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss publishing notice"
          data-testid="docs-publish-waitlist-banner-dismiss"
          style={{
            flexShrink: 0,
            border: 'none',
            background: 'transparent',
            color: 'var(--muted)',
            cursor: 'pointer',
            fontSize: 18,
            lineHeight: 1,
            padding: '0 4px',
            fontFamily: 'inherit',
          }}
        >
          ×
        </button>
      </div>
    </div>
  );
}
