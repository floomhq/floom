// Cookie consent banner.
//
// Desktop / tablet (≥768px, #342): full-width bottom strip (Linear / Vercel
// style) — does not float as a card over primary content. Content gets
// `padding-bottom` on the root while the banner is visible so the fold
// stays readable.
//
// Mobile (<768px, #104): small bottom-left "Cookies" pill; tap expands to
// the same strip treatment with a close control.
//
// Storage + consent lives in `lib/consent.ts` (so the telemetry modules
// can read the choice without importing React). This component calls
// `setConsent` AND inlines `initBrowserSentry` / `initPostHog` (on "Accept
// all") and their close equivalents (on the "all" -> "essential" downgrade)
// so the choice applies in the same session without a reload.
//
// Root-padding sizing (audit 2026-04-24): the old implementation reserved
// a hardcoded 84px on `<html>`. That fit a single-line banner at ≥1200px
// but under-reserved at medium widths (buttons + long copy wrap to two
// lines, banner grows to ~110px) and dramatically under-reserved when the
// mobile strip is expanded (content stacks, can be 150–180px tall). On
// /pricing and /docs this surfaced as the banner covering the `$0` card
// spec line and the 3-column install grid mid-scroll. Fix: measure the
// banner with ResizeObserver on every mount / resize and publish the value
// to a CSS custom property `--cookie-banner-height` on <html>. Root
// padding then becomes `var(--cookie-banner-height, 0px)`, set once in
// globals.css. This keeps the two concerns (height measurement vs. page
// reservation) decoupled so any layout can also read the var directly
// (e.g. sticky anchors, scroll-into-view offsets).

import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { getConsent, setConsent, type Consent } from '../lib/consent';
import { initBrowserSentry, closeBrowserSentry } from '../lib/sentry';
import { initPostHog, closePostHog } from '../lib/posthog';

/** Viewport width below this uses the collapsed mobile pill first. */
const MOBILE_BREAKPOINT = 768;

/**
 * Minimum height reserved even while the banner is measuring. Avoids a
 * 1-frame flash where content jumps up into the banner's area before the
 * ResizeObserver fires. Matches the desktop single-line case so the
 * initial reservation is already close to the final value.
 */
const INITIAL_RESERVE_PX = 72;

function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return isMobile;
}

export function CookieBanner() {
  const [visible, setVisible] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const isMobile = useIsMobile();
  const stripRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (getConsent() === null) setVisible(true);
  }, []);

  const showStrip = visible && (!isMobile || expanded);

  // Publish the banner's live height to the document root as
  // `--cookie-banner-height`. globals.css reads this variable to reserve
  // room on <html> (and any layout can read it for scroll offsets). When
  // the strip isn't mounted the variable is cleared so padding collapses
  // to the `0px` fallback.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    if (!showStrip) {
      root.style.removeProperty('--cookie-banner-height');
      return undefined;
    }

    const node = stripRef.current;
    if (!node) {
      // Strip will mount this render; set an initial reserve so the first
      // paint doesn't flash content under an unmeasured banner.
      root.style.setProperty('--cookie-banner-height', `${INITIAL_RESERVE_PX}px`);
      return () => {
        root.style.removeProperty('--cookie-banner-height');
      };
    }

    const applyHeight = () => {
      const h = Math.ceil(node.getBoundingClientRect().height);
      if (h > 0) {
        root.style.setProperty('--cookie-banner-height', `${h}px`);
      }
    };
    applyHeight();

    // ResizeObserver handles button wrap, text reflow and the mobile
    // expanded stack. Falls back silently on very old browsers (iOS <13.4)
    // that lack it — users there keep the INITIAL_RESERVE_PX reservation,
    // which is still better than the old hardcoded 84px because
    // --cookie-banner-height now drives all consumers from one source.
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(applyHeight);
      observer.observe(node);
    }

    // Also re-apply on viewport resize (covers orientation change, which
    // may not trigger a content resize on the banner itself if text
    // wrapping already consumed the width).
    window.addEventListener('resize', applyHeight);

    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', applyHeight);
      root.style.removeProperty('--cookie-banner-height');
    };
  }, [showStrip, expanded, isMobile]);

  if (!visible) return null;

  const accept = (choice: Consent) => {
    const previous = getConsent();
    setConsent(choice);
    if (choice === 'all') {
      initBrowserSentry();
      initPostHog();
    } else if (previous === 'all') {
      closeBrowserSentry();
      closePostHog();
    }
    setVisible(false);
  };

  if (isMobile && !expanded) {
    return (
      <button
        type="button"
        data-testid="cookie-banner-pill"
        onClick={() => setExpanded(true)}
        aria-label="Cookie consent"
        style={{
          position: 'fixed',
          left: 12,
          bottom: 12,
          zIndex: 950,
          padding: '7px 12px',
          background: 'var(--card)',
          border: '1px solid var(--line)',
          borderRadius: 999,
          boxShadow: '0 6px 20px rgba(14, 14, 12, 0.12)',
          fontFamily: 'inherit',
          fontSize: 12,
          fontWeight: 600,
          color: 'var(--ink)',
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        Cookies
      </button>
    );
  }

  const isExpandedMobile = isMobile && expanded;

  return (
    <div
      ref={stripRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="cookie-banner-title"
      data-testid="cookie-banner"
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 950,
        paddingLeft: 'max(16px, env(safe-area-inset-left, 0px))',
        paddingRight: 'max(16px, env(safe-area-inset-right, 0px))',
        paddingTop: 12,
        paddingBottom: 'max(12px, env(safe-area-inset-bottom, 0px))',
        minHeight: 56,
        maxWidth: '100%',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'row',
        flexWrap: isExpandedMobile ? 'wrap' : 'nowrap',
        alignItems: 'center',
        gap: 12,
        background: 'var(--bg)',
        backdropFilter: 'blur(12px) saturate(1.06)',
        WebkitBackdropFilter: 'blur(12px) saturate(1.06)',
        borderTop: '1px solid var(--line)',
        borderRadius: 0,
        boxShadow: '0 -4px 24px rgba(15, 23, 42, 0.08)',
        fontSize: 12.5,
        color: 'var(--ink)',
      }}
    >
      <p
        id="cookie-banner-title"
        style={{
          margin: 0,
          flex: '1 1 0',
          minWidth: 0,
          lineHeight: 1.45,
        }}
      >
        Floom uses essential cookies for sign-in and preferences. Choose
        &quot;Accept all&quot; to also help us with anonymised analytics and error
        reporting. See the{' '}
        <Link to="/cookies" style={{ color: 'var(--accent)', textDecoration: 'underline' }}>
          cookie policy
        </Link>
        .
      </p>
      <div
        style={{
          display: 'flex',
          gap: 8,
          flexWrap: 'wrap',
          alignItems: 'center',
          flexShrink: 0,
          marginLeft: isExpandedMobile ? 0 : 'auto',
        }}
      >
        <button
          type="button"
          onClick={() => accept('essential')}
          style={{
            padding: '8px 14px',
            minHeight: 44,
            borderRadius: 8,
            border: '1px solid var(--line)',
            background: 'transparent',
            color: 'var(--ink)',
            cursor: 'pointer',
            fontFamily: 'inherit',
            fontSize: 12.5,
            fontWeight: 600,
            boxSizing: 'border-box',
          }}
        >
          Essential only
        </button>
        <button
          type="button"
          onClick={() => accept('all')}
          style={{
            padding: '8px 14px',
            minHeight: 44,
            borderRadius: 8,
            border: '1px solid var(--accent)',
            background: 'var(--accent)',
            color: '#fff',
            cursor: 'pointer',
            fontFamily: 'inherit',
            fontSize: 12.5,
            fontWeight: 600,
            boxSizing: 'border-box',
          }}
        >
          Accept all
        </button>
        {isExpandedMobile && (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            aria-label="Close"
            style={{
              padding: '8px 12px',
              minHeight: 44,
              borderRadius: 8,
              border: '1px solid var(--line)',
              background: 'transparent',
              color: 'var(--muted)',
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontSize: 14,
              fontWeight: 600,
              lineHeight: 1,
              boxSizing: 'border-box',
            }}
          >
            ×
          </button>
        )}
      </div>
    </div>
  );
}
