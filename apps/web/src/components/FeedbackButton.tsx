// W4-minimal: global floating feedback button.
//
// Fixed bottom-right on every page. Click opens a modal with a textarea +
// optional email field. POSTs to /api/feedback on submit. Includes the
// current URL automatically so Federico can see context when triaging.
//
// Supports ?feedback=open query param for demo links.

import { useEffect, useState } from 'react';
import { useSearchParams, useLocation } from 'react-router-dom';
import * as api from '../api/client';

export function FeedbackButton() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();

  // Support ?feedback=open deep link (used for demo URLs)
  useEffect(() => {
    if (searchParams.get('feedback') === 'open') {
      setOpen(true);
    }
  }, [searchParams]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setState('sending');
    try {
      await api.postFeedback({
        text: text.trim(),
        email: email.trim() || undefined,
        url: typeof window !== 'undefined' ? window.location.href : location.pathname,
      });
      setState('sent');
      setText('');
      setEmail('');
      setTimeout(() => {
        setOpen(false);
        setState('idle');
        if (searchParams.get('feedback') === 'open') {
          const sp = new URLSearchParams(searchParams);
          sp.delete('feedback');
          setSearchParams(sp, { replace: true });
        }
      }, 1500);
    } catch (err) {
      setState('error');
      setErrorMsg((err as Error).message || 'Send failed');
    }
  }

  function close() {
    setOpen(false);
    setState('idle');
    setErrorMsg('');
    if (searchParams.get('feedback') === 'open') {
      const sp = new URLSearchParams(searchParams);
      sp.delete('feedback');
      setSearchParams(sp, { replace: true });
    }
  }

  return (
    <>
      {/* Landing visual audit 2026-04-18: on 375px viewports the floating
          trigger overlapped the hero "Try it" button and /imprint's
          first body section. Hide the trigger on small screens; the
          modal itself stays reachable via ?feedback=open deep links. */}
      <style>{`
        @media (max-width: 640px) {
          [data-testid="feedback-trigger"] { display: none !important; }
        }
      `}</style>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="feedback-trigger"
        aria-label="Send feedback"
        style={{
          position: 'fixed',
          bottom: 20,
          right: 20,
          zIndex: 900,
          padding: '10px 16px',
          background: 'var(--ink)',
          color: '#fff',
          border: 'none',
          borderRadius: 999,
          fontSize: 13,
          fontWeight: 600,
          fontFamily: 'inherit',
          boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M3 4h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H8l-3 2v-2H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
        </svg>
        Feedback
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Send feedback"
          data-testid="feedback-modal"
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
          onClick={close}
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
                marginBottom: 16,
              }}
            >
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: 'var(--ink)' }}>
                Send feedback
              </h2>
              <button
                type="button"
                onClick={close}
                aria-label="Close"
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

            {state === 'sent' ? (
              <p
                style={{
                  margin: 0,
                  fontSize: 14,
                  color: 'var(--success, #1a7f37)',
                  padding: '20px 0',
                  textAlign: 'center',
                }}
              >
                Thanks! Feedback received.
              </p>
            ) : (
              <form onSubmit={handleSubmit}>
                <label
                  style={{
                    display: 'block',
                    fontSize: 12,
                    fontWeight: 600,
                    color: 'var(--muted)',
                    marginBottom: 6,
                  }}
                >
                  What's on your mind?
                </label>
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  required
                  rows={5}
                  autoFocus
                  placeholder="Bug report, feature idea, confusion, praise: all welcome."
                  data-testid="feedback-text"
                  style={{
                    width: '100%',
                    padding: 12,
                    border: '1px solid var(--line)',
                    borderRadius: 8,
                    background: 'var(--bg)',
                    fontFamily: 'inherit',
                    fontSize: 14,
                    color: 'var(--ink)',
                    resize: 'vertical',
                    minHeight: 100,
                    marginBottom: 12,
                  }}
                />
                <label
                  style={{
                    display: 'block',
                    fontSize: 12,
                    fontWeight: 600,
                    color: 'var(--muted)',
                    marginBottom: 6,
                  }}
                >
                  Email (optional, if you want a reply)
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  data-testid="feedback-email"
                  style={{
                    width: '100%',
                    padding: '10px 12px',
                    border: '1px solid var(--line)',
                    borderRadius: 8,
                    background: 'var(--bg)',
                    fontFamily: 'inherit',
                    fontSize: 14,
                    color: 'var(--ink)',
                    marginBottom: 16,
                  }}
                />
                {state === 'error' && (
                  <p
                    style={{
                      margin: '0 0 12px',
                      fontSize: 13,
                      color: 'var(--warning, #c2791c)',
                    }}
                  >
                    {errorMsg}
                  </p>
                )}
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button
                    type="button"
                    onClick={close}
                    style={{
                      padding: '8px 16px',
                      background: 'transparent',
                      border: '1px solid var(--line)',
                      borderRadius: 8,
                      fontSize: 13,
                      color: 'var(--muted)',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={state === 'sending' || !text.trim()}
                    data-testid="feedback-submit"
                    style={{
                      padding: '8px 16px',
                      background: 'var(--ink)',
                      border: 'none',
                      borderRadius: 8,
                      fontSize: 13,
                      fontWeight: 600,
                      color: '#fff',
                      cursor: state === 'sending' ? 'not-allowed' : 'pointer',
                      opacity: state === 'sending' || !text.trim() ? 0.6 : 1,
                      fontFamily: 'inherit',
                    }}
                  >
                    {state === 'sending' ? 'Sending...' : 'Send feedback'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </>
  );
}
