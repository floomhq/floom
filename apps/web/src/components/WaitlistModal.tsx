/**
 * WaitlistModal — deploy waitlist signup, launch 2026-04-27.
 *
 * Renders when `open` is true. Posts to /api/waitlist with the caller's
 * `source` tag ("hero" / "studio-deploy" / "me-publish" / …) so we can
 * slice the signup funnel by surface after the launch.
 *
 * The server is idempotent, so "already signed up" is indistinguishable
 * from a fresh signup from the client's POV — we always show the
 * success state on 200. That's intentional: the UX goal is "the user
 * feels like they're on the list", not "the user learns whether their
 * address was already in our database".
 *
 * Failure modes:
 *   - Invalid email (rejected by the client regex before POST) → inline
 *     error, form stays open.
 *   - Network / 4xx / 5xx → inline error, form stays open, user can
 *     retry.
 *   - Rate-limit (429) → inline error with the "try again later"
 *     copy; form stays open.
 *
 * Styling follows BYOKModal.tsx (inline styles + CSS variables) so it
 * inherits the Floom theme without a Tailwind detour.
 */

import { useEffect, useRef, useState } from 'react';
import { submitWaitlist, ApiError } from '../api/client';

export interface WaitlistModalProps {
  open: boolean;
  onClose: () => void;
  /**
   * Which surface the modal was opened from. Persisted alongside the
   * email so we can measure conversion per CTA. Free-form; the server
   * truncates to 64 chars. Examples: "hero", "studio-deploy",
   * "me-publish", "landing-ship-cta", "topbar-signup".
   */
  source?: string;
  /**
   * Optional custom heading. Falls back to "Join the waitlist". Useful
   * when the originating CTA already framed the value prop and the
   * modal just needs a matching verb ("Get early access").
   */
  title?: string;
  /**
   * Milliseconds to wait after a successful signup before auto-closing.
   * Defaults to 3000. Set to 0 to disable auto-close (the test harness
   * uses this so assertions can observe the success state).
   */
  autoCloseMs?: number;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function WaitlistModal({
  open,
  onClose,
  source,
  title,
  autoCloseMs = 3000,
}: WaitlistModalProps) {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Reset on open/close. We don't want a stale success state bleeding
    // into a second opening from a different CTA.
    if (!open) {
      setEmail('');
      setError(null);
      setSubmitting(false);
      setSuccess(false);
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
    }
  }, [open]);

  useEffect(() => {
    // Auto-close after success. Using a ref so the timer is cancellable
    // if the user clicks the backdrop before it fires.
    if (!success || autoCloseMs <= 0) return;
    closeTimerRef.current = setTimeout(() => {
      onClose();
    }, autoCloseMs);
    return () => {
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
    };
  }, [success, autoCloseMs, onClose]);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = email.trim();
    if (!EMAIL_RE.test(trimmed)) {
      setError('Please enter a valid email address.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await submitWaitlist({ email: trimmed, source });
      setSuccess(true);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 429) {
          setError('Too many signups from this network. Try again in an hour.');
        } else if (err.status === 400) {
          setError('That email looked invalid to the server. Double-check and retry.');
        } else {
          setError('Something went wrong on our end. Please try again.');
        }
      } else {
        setError('Network error. Check your connection and try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const heading = title || 'Join the waitlist';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={heading}
      data-testid="waitlist-modal"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--card)',
          border: '1px solid var(--line)',
          borderRadius: 12,
          padding: 24,
          maxWidth: 440,
          width: '100%',
          boxShadow: '0 16px 48px rgba(0,0,0,0.2)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 12,
          }}
        >
          <h2
            style={{
              margin: 0,
              fontSize: 18,
              fontWeight: 700,
              color: 'var(--ink)',
            }}
          >
            {success ? "You're in." : heading}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            data-testid="waitlist-close"
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--muted)',
              fontSize: 20,
              cursor: 'pointer',
              padding: 0,
              width: 24,
              height: 24,
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>

        {success ? (
          <div data-testid="waitlist-success">
            <p
              style={{
                margin: '0 0 12px',
                fontSize: 14,
                lineHeight: 1.55,
                color: 'var(--muted)',
              }}
            >
              Thanks — we&rsquo;ll email you when your slot opens. In the
              meantime you can still run the featured apps for free.
            </p>
            <p
              style={{
                margin: 0,
                fontSize: 12,
                color: 'var(--muted)',
              }}
            >
              You can close this window.
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <p
              style={{
                margin: '0 0 14px',
                fontSize: 14,
                lineHeight: 1.55,
                color: 'var(--muted)',
              }}
            >
              Floom is rolling out deploy slowly. Drop your email and
              we&rsquo;ll let you know when you can publish your own app.
            </p>
            <label
              style={{
                display: 'block',
                fontSize: 12,
                fontWeight: 600,
                color: 'var(--muted)',
                marginBottom: 6,
              }}
              htmlFor="waitlist-email-input"
            >
              Email
            </label>
            <input
              id="waitlist-email-input"
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                if (error) setError(null);
              }}
              autoFocus
              placeholder="you@example.com"
              data-testid="waitlist-email-input"
              autoComplete="email"
              spellCheck={false}
              disabled={submitting}
              style={{
                width: '100%',
                padding: 12,
                border: `1px solid ${error ? 'var(--danger, #e5484d)' : 'var(--line)'}`,
                borderRadius: 8,
                background: 'var(--bg)',
                color: 'var(--ink)',
                fontSize: 14,
                boxSizing: 'border-box',
                marginBottom: error ? 6 : 14,
              }}
            />
            {error && (
              <div
                data-testid="waitlist-error"
                role="alert"
                style={{
                  fontSize: 12,
                  color: 'var(--danger, #e5484d)',
                  marginBottom: 10,
                }}
              >
                {error}
              </div>
            )}
            <button
              type="submit"
              disabled={submitting}
              data-testid="waitlist-submit"
              style={{
                width: '100%',
                padding: '12px 16px',
                border: 'none',
                borderRadius: 8,
                background: 'var(--ink)',
                color: 'var(--card)',
                fontSize: 14,
                fontWeight: 600,
                cursor: submitting ? 'default' : 'pointer',
                opacity: submitting ? 0.7 : 1,
              }}
            >
              {submitting ? 'Joining…' : 'Join waitlist'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
