// CoachMark — absolutely-positioned popover anchored to a DOM element
// by data-testid. Used by the first-run tour instead of a full-screen
// modal so the underlying page stays interactive (perceived speed).
//
// Positioning: we read the target's bounding rect on mount + on resize +
// on scroll. No portals, no libraries — the CoachMark lives in its own
// fixed-position layer so it survives overflow:hidden parents. Target
// element gets scrolled into view (smooth, nearest block) if it's off
// screen on mount.
//
// a11y:
//   - role="dialog", aria-labelledby for the heading
//   - focus is moved to the primary button on open
//   - Escape closes via onSkip (Tour owns what "close" means)

import type { CSSProperties, ReactNode } from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export type CoachMarkPlacement = 'top' | 'bottom' | 'left' | 'right';

export interface CoachMarkProps {
  /** data-testid on the DOM node this mark should anchor to. */
  anchorTestId: string;
  title: string;
  body: ReactNode;
  step: number;
  totalSteps: number;
  primaryLabel: string;
  onPrimary: () => void;
  onSkip: () => void;
  placement?: CoachMarkPlacement;
  /** Optional: disable the primary button (e.g., until a click happens). */
  primaryDisabled?: boolean;
  /** Optional: secondary "Back" control. */
  onBack?: () => void;
  /** Pulse a ring around the anchor to draw attention. */
  pulse?: boolean;
}

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

function readRect(el: Element | null): Rect | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

export function CoachMark({
  anchorTestId,
  title,
  body,
  step,
  totalSteps,
  primaryLabel,
  onPrimary,
  onSkip,
  placement = 'bottom',
  primaryDisabled,
  onBack,
  pulse,
}: CoachMarkProps) {
  const [rect, setRect] = useState<Rect | null>(null);
  const primaryRef = useRef<HTMLButtonElement | null>(null);

  // Re-locate the anchor on every paint — the target may not exist on
  // first render (it could be in a route that's still mounting). A
  // lightweight rAF loop for 2s handles that without a MutationObserver.
  useLayoutEffect(() => {
    let cancelled = false;
    const started = performance.now();
    const tick = () => {
      if (cancelled) return;
      const el = document.querySelector(`[data-testid="${anchorTestId}"]`);
      const r = readRect(el);
      setRect(r);
      if (el) {
        // Scroll into view (smooth) once — only when off screen.
        const vpH = window.innerHeight;
        if (r && (r.top < 40 || r.top > vpH - 80)) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }
      if (performance.now() - started < 2000) {
        requestAnimationFrame(tick);
      }
    };
    tick();
    return () => {
      cancelled = true;
    };
  }, [anchorTestId]);

  // Track scroll + resize to keep the popover glued to the anchor.
  useEffect(() => {
    const onMove = () => {
      const el = document.querySelector(`[data-testid="${anchorTestId}"]`);
      setRect(readRect(el));
    };
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [anchorTestId]);

  // Focus the primary button on open.
  useEffect(() => {
    primaryRef.current?.focus();
  }, []);

  // Escape = skip.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onSkip();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onSkip]);

  // Compute popover position from anchor rect + placement. When the
  // anchor isn't found we render a centered fallback so the tour never
  // hard-stalls.
  const POPOVER_W = 340;
  const POPOVER_MAX_H = 260;
  const GAP = 12;
  const style: CSSProperties = { position: 'fixed', zIndex: 10001, width: POPOVER_W };
  if (!rect) {
    // Centered fallback.
    style.top = '50%';
    style.left = '50%';
    style.transform = 'translate(-50%, -50%)';
  } else {
    const vpW = window.innerWidth;
    const vpH = window.innerHeight;
    let top = rect.top;
    let left = rect.left;
    switch (placement) {
      case 'top':
        top = rect.top - POPOVER_MAX_H - GAP;
        left = rect.left + rect.width / 2 - POPOVER_W / 2;
        break;
      case 'bottom':
        top = rect.top + rect.height + GAP;
        left = rect.left + rect.width / 2 - POPOVER_W / 2;
        break;
      case 'left':
        top = rect.top + rect.height / 2 - 80;
        left = rect.left - POPOVER_W - GAP;
        break;
      case 'right':
        top = rect.top + rect.height / 2 - 80;
        left = rect.left + rect.width + GAP;
        break;
    }
    // Clamp to viewport.
    top = Math.max(12, Math.min(top, vpH - POPOVER_MAX_H - 12));
    left = Math.max(12, Math.min(left, vpW - POPOVER_W - 12));
    style.top = top;
    style.left = left;
  }

  return (
    <>
      {/* Pulsing halo anchored over the target (positioned, not clipping). */}
      {pulse && rect && (
        <div
          aria-hidden
          data-testid="onboarding-pulse"
          style={{
            position: 'fixed',
            top: rect.top - 6,
            left: rect.left - 6,
            width: rect.width + 12,
            height: rect.height + 12,
            borderRadius: 14,
            boxShadow: '0 0 0 3px rgba(16, 185, 129, 0.55)',
            animation: 'floom-onboarding-pulse 1.8s ease-out infinite',
            pointerEvents: 'none',
            zIndex: 10000,
          }}
        />
      )}

      <div
        role="dialog"
        aria-modal="false"
        aria-labelledby="onboarding-title"
        data-testid="onboarding-coachmark"
        style={{
          ...style,
          background: 'var(--card, #fff)',
          border: '1px solid var(--line, #e5e7eb)',
          borderRadius: 14,
          padding: '16px 18px 14px',
          boxShadow: '0 18px 48px rgba(15, 23, 42, 0.18)',
          fontSize: 14,
          lineHeight: 1.55,
          color: 'var(--ink, #0f172a)',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 8,
          }}
        >
          <span
            data-testid="onboarding-progress"
            style={{
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: 0.4,
              textTransform: 'uppercase',
              color: 'var(--muted, #64748b)',
            }}
          >
            Step {step} of {totalSteps}
          </span>
          <button
            type="button"
            onClick={onSkip}
            data-testid="onboarding-skip"
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--muted, #64748b)',
              fontSize: 12,
              cursor: 'pointer',
              padding: 0,
            }}
          >
            Skip
          </button>
        </div>
        <h2
          id="onboarding-title"
          style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--ink, #0f172a)' }}
        >
          {title}
        </h2>
        <div style={{ marginTop: 6, color: 'var(--muted, #475569)' }}>{body}</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 14, justifyContent: 'flex-end' }}>
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              data-testid="onboarding-back"
              style={{
                padding: '8px 12px',
                borderRadius: 8,
                border: '1px solid var(--line, #e5e7eb)',
                background: 'var(--card, #fff)',
                color: 'var(--ink, #0f172a)',
                fontSize: 13,
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              Back
            </button>
          )}
          <button
            type="button"
            ref={primaryRef}
            onClick={onPrimary}
            disabled={primaryDisabled}
            data-testid="onboarding-primary"
            style={{
              padding: '8px 14px',
              borderRadius: 8,
              border: 'none',
              background: primaryDisabled
                ? 'var(--line, #e5e7eb)'
                : 'var(--accent, #10b981)',
              color: primaryDisabled ? 'var(--muted, #64748b)' : '#fff',
              fontSize: 13,
              fontWeight: 600,
              cursor: primaryDisabled ? 'default' : 'pointer',
            }}
          >
            {primaryLabel}
          </button>
        </div>
      </div>

    </>
  );
}
