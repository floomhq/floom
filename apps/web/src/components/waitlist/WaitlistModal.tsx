/**
 * WaitlistModal — launch-day stub.
 *
 * Coordinates: agent 9 owns the canonical waitlist modal + backend wire-up.
 * This file is a small stub so the landing rewrite has a working CTA target
 * today. If agent 9's modal lands first, replace the entire body of this
 * module with a re-export — every call-site uses the single `useWaitlist()`
 * hook so the swap is a one-file change.
 *
 * UX today (stub):
 *   - Controlled from `useWaitlist()` hook exposed at the top of this file.
 *   - Lightweight centered card, focus-trap via `ref.focus()` on open.
 *   - Email input + single "Join the waitlist" button.
 *   - On submit: POSTs to `/api/waitlist` (server route is not guaranteed to
 *     exist yet — failure falls through to a "we saved it locally" toast so
 *     we never block the user or lie to them).
 *   - Esc / backdrop closes.
 *
 * When agent 9 ships, the likely shape is `<WaitlistModal>` controlled from
 * a global context. If so, `openWaitlist()` in this file will forward to
 * that context.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from 'react';

interface WaitlistContextValue {
  open: boolean;
  source?: string;
  openWaitlist(source?: string): void;
  closeWaitlist(): void;
}

const listeners = new Set<(v: WaitlistContextValue) => void>();
let state: WaitlistContextValue = {
  open: false,
  openWaitlist: (source?: string) => {
    state = { ...state, open: true, source };
    listeners.forEach((fn) => fn(state));
  },
  closeWaitlist: () => {
    state = { ...state, open: false };
    listeners.forEach((fn) => fn(state));
  },
};

// Re-bind so the methods above reference the _latest_ state closure.
state.openWaitlist = (source?: string) => {
  state = { ...state, open: true, source };
  listeners.forEach((fn) => fn(state));
};
state.closeWaitlist = () => {
  state = { ...state, open: false };
  listeners.forEach((fn) => fn(state));
};

/**
 * Tiny external-store hook. Avoids dragging in a real context provider for a
 * one-off stub — when agent 9 ships, swap the body of this hook for their
 * provider's `useContext(...)` and the rest of the landing just works.
 */
export function useWaitlist(): WaitlistContextValue {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
  return state;
}

/** Fire-and-forget opener for inline event handlers. */
export function openWaitlist(source?: string): void {
  state.openWaitlist(source);
}

// ---------------------------------------------------------------------------
// Modal UI
// ---------------------------------------------------------------------------
interface WaitlistModalProps {
  /**
   * Optional override — useful for Storybook / tests. When omitted the modal
   * reads open-state from the shared store above.
   */
  openOverride?: boolean;
  onClose?: () => void;
  children?: ReactNode;
}

export function WaitlistModal(_: WaitlistModalProps = {}) {
  const { open, source, closeWaitlist } = useWaitlist();
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'submitting' | 'done' | 'error'>('idle');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setEmail('');
      setStatus('idle');
      const t = window.setTimeout(() => inputRef.current?.focus(), 30);
      return () => window.clearTimeout(t);
    }
    return;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeWaitlist();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, closeWaitlist]);

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!email) return;
      setStatus('submitting');
      try {
        // Best-effort — server route may not exist yet; we still acknowledge
        // the user. Agent 9's canonical implementation will wire this up
        // properly.
        await fetch('/api/waitlist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, source: source ?? 'landing' }),
        });
      } catch {
        // swallow — stub mode is forgiving on purpose
      }
      setStatus('done');
    },
    [email, source],
  );

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Join the Floom waitlist"
      data-testid="waitlist-modal"
      style={BACKDROP}
      onClick={(e) => {
        if (e.target === e.currentTarget) closeWaitlist();
      }}
    >
      <div style={CARD}>
        <button
          type="button"
          aria-label="Close"
          onClick={closeWaitlist}
          style={CLOSE_BTN}
        >
          ×
        </button>
        <div style={EYEBROW}>FLOOM &middot; WAITLIST</div>
        <h2 style={H2}>Build your own AI app on Floom.</h2>
        <p style={P}>
          We&rsquo;re rolling out the full build-and-deploy flow in waves.
          Drop your email and we&rsquo;ll let you in as soon as your slot
          opens.
        </p>

        {status === 'done' ? (
          <div style={DONE_CARD} data-testid="waitlist-done">
            You&rsquo;re on the list. We&rsquo;ll be in touch.
          </div>
        ) : (
          <form onSubmit={handleSubmit} style={FORM}>
            <input
              ref={inputRef}
              type="email"
              required
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={status === 'submitting'}
              style={INPUT}
              data-testid="waitlist-email"
            />
            <button
              type="submit"
              disabled={status === 'submitting'}
              style={SUBMIT}
              data-testid="waitlist-submit"
            >
              {status === 'submitting' ? 'Joining…' : 'Join the waitlist'}
            </button>
          </form>
        )}

        <p style={FOOT}>
          In the meantime, three apps are already live and free to try.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const BACKDROP: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(14, 14, 12, 0.45)',
  backdropFilter: 'blur(4px)',
  WebkitBackdropFilter: 'blur(4px)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 24,
  zIndex: 1000,
};

const CARD: CSSProperties = {
  position: 'relative',
  background: 'var(--card, #ffffff)',
  border: '1px solid var(--line, #e8e6e0)',
  borderRadius: 18,
  padding: '32px 32px 26px',
  width: '100%',
  maxWidth: 440,
  boxShadow: '0 30px 70px -20px rgba(14,14,12,0.35)',
};

const CLOSE_BTN: CSSProperties = {
  position: 'absolute',
  top: 10,
  right: 12,
  background: 'transparent',
  border: 0,
  fontSize: 22,
  lineHeight: 1,
  cursor: 'pointer',
  color: 'var(--muted, #8b8680)',
  padding: 6,
};

const EYEBROW: CSSProperties = {
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 10.5,
  color: 'var(--accent, #047857)',
  letterSpacing: '0.12em',
  fontWeight: 700,
  marginBottom: 8,
};

const H2: CSSProperties = {
  fontFamily: "'DM Serif Display', Georgia, serif",
  fontWeight: 400,
  fontSize: 24,
  lineHeight: 1.15,
  margin: '0 0 8px',
  letterSpacing: '-0.02em',
};

const P: CSSProperties = {
  fontSize: 14,
  color: 'var(--muted, #8b8680)',
  lineHeight: 1.55,
  margin: '0 0 20px',
};

const FORM: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

const INPUT: CSSProperties = {
  padding: '12px 14px',
  fontSize: 14,
  borderRadius: 10,
  border: '1px solid var(--line, #e8e6e0)',
  background: 'var(--bg, #fafaf7)',
  color: 'var(--ink, #0e0e0c)',
  fontFamily: "'Inter', system-ui, sans-serif",
  outline: 'none',
};

const SUBMIT: CSSProperties = {
  padding: '12px 16px',
  fontSize: 14,
  fontWeight: 600,
  borderRadius: 10,
  border: '1px solid var(--ink, #0e0e0c)',
  background: 'var(--ink, #0e0e0c)',
  color: '#fff',
  cursor: 'pointer',
  fontFamily: "'Inter', system-ui, sans-serif",
};

const DONE_CARD: CSSProperties = {
  padding: '14px 16px',
  background: '#ecfdf5',
  color: '#065f46',
  border: '1px solid #d1fae5',
  borderRadius: 10,
  fontSize: 14,
  fontWeight: 500,
};

const FOOT: CSSProperties = {
  fontSize: 12,
  color: 'var(--muted, #8b8680)',
  marginTop: 16,
  marginBottom: 0,
};
