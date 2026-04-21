// Smart feedback: three-step modal for the global feedback button.
//
// Step 1 (compose): textarea + "Review" button. User pastes raw thoughts.
// Step 2 (confirm): parsed preview with editable title + description, a
//                   bucket pill (bug / feature / question / feedback),
//                   "notify me when resolved" checkbox, email line
//                   (read-only if signed in, optional input if not),
//                   "Submit" + "Back" buttons.
// Step 3 (success): "Filed #<num>" with link to the issue, "Close".
//
// The "Review" step calls POST /api/feedback/parse (Gemini under the hood)
// and never blocks: the server falls back to the raw text + bucket=feedback
// if Gemini is unavailable, so the user always gets to step 2.
//
// Design tokens match the rest of Floom: var(--ink) / var(--line) /
// var(--card) / var(--bg) / var(--accent) / var(--muted). No new colors.
//
// Backwards compatible with the previous button: same ?feedback=open deep
// link, same fixed bottom-right / mobile bottom-left positioning, same
// data-testid hooks so smoke tests don't need updating.

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams, useLocation } from 'react-router-dom';
import * as api from '../api/client';
import type { FeedbackBucket, ParsedFeedback } from '../api/client';
import { useSession } from '../hooks/useSession';

type Step = 'compose' | 'confirm' | 'success';

const BUCKET_LABELS: Record<FeedbackBucket, string> = {
  bug: 'Bug',
  feature: 'Feature request',
  question: 'Question',
  feedback: 'Feedback',
};

export function FeedbackButton() {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>('compose');

  // Step 1 state
  const [text, setText] = useState('');

  // Step 2 state (hydrated from /api/feedback/parse)
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [bucket, setBucket] = useState<FeedbackBucket>('feedback');
  const [notify, setNotify] = useState(true);
  const [anonEmail, setAnonEmail] = useState('');

  // Step 3 state
  const [issueUrl, setIssueUrl] = useState('');
  const [issueNumber, setIssueNumber] = useState<number | null>(null);

  // Async state
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const { data: session, isAuthenticated } = useSession();

  // Resolve the user's email from the session cache. `is_local` users in
  // OSS mode don't count as signed in — we treat them as anonymous so the
  // email field is editable.
  const signedInEmail = useMemo<string | null>(() => {
    if (!session || !isAuthenticated) return null;
    return session.user.email || null;
  }, [session, isAuthenticated]);

  // Support ?feedback=open deep link (used for demo URLs)
  useEffect(() => {
    if (searchParams.get('feedback') === 'open') {
      setOpen(true);
    }
  }, [searchParams]);

  function resetAll(): void {
    setStep('compose');
    setText('');
    setTitle('');
    setDescription('');
    setBucket('feedback');
    setNotify(true);
    setAnonEmail('');
    setIssueUrl('');
    setIssueNumber(null);
    setErrorMsg('');
    setBusy(false);
  }

  function close(): void {
    setOpen(false);
    resetAll();
    if (searchParams.get('feedback') === 'open') {
      const sp = new URLSearchParams(searchParams);
      sp.delete('feedback');
      setSearchParams(sp, { replace: true });
    }
  }

  async function handleReview(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    setErrorMsg('');
    try {
      const parsed: ParsedFeedback = await api.parseFeedback({ text: text.trim() });
      setTitle(parsed.title);
      setDescription(parsed.description);
      setBucket(parsed.bucket);
      // Default "notify me" on for signed-in users (we already have their
      // email), off for anonymous (they have to opt in with an email).
      setNotify(!!signedInEmail);
      setStep('confirm');
    } catch (err) {
      setErrorMsg((err as Error).message || 'Review failed. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    if (!title.trim() || !description.trim()) {
      setErrorMsg('Title and description are required.');
      return;
    }
    const wantEmail = notify && !signedInEmail ? anonEmail.trim() : '';
    if (notify && !signedInEmail && !wantEmail) {
      setErrorMsg('Enter an email or uncheck the notify box.');
      return;
    }
    setBusy(true);
    setErrorMsg('');
    try {
      const url = typeof window !== 'undefined' ? window.location.href : location.pathname;
      const result = await api.submitFeedback({
        title: title.trim(),
        description: description.trim(),
        bucket,
        notify,
        email: signedInEmail ? undefined : wantEmail || undefined,
        url,
      });
      setIssueUrl(result.issue_url);
      setIssueNumber(result.issue_number);
      setStep('success');
    } catch (err) {
      setErrorMsg((err as Error).message || 'Submit failed. Try again.');
    } finally {
      setBusy(false);
    }
  }

  // ------------------ render ------------------

  return (
    <>
      {/* Pre-launch: feedback must be reachable on mobile too. Compact
          icon-only pill in the bottom-left on ≤640px so it doesn't cover
          the viewport-centered CTAs. Same rule as the legacy button. */}
      <style>{`
        @media (max-width: 640px) {
          [data-testid="feedback-trigger"] {
            bottom: 12px !important;
            right: auto !important;
            left: 12px !important;
            padding: 7px 10px !important;
            font-size: 12px !important;
          }
          [data-testid="feedback-trigger"] .feedback-trigger-label {
            display: none;
          }
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
        <span className="feedback-trigger-label">Feedback</span>
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
              maxWidth: 520,
              width: '100%',
              boxShadow: '0 16px 48px rgba(0,0,0,0.2)',
              maxHeight: '90vh',
              overflowY: 'auto',
            }}
          >
            <ModalHeader
              title={
                step === 'compose'
                  ? 'Send feedback'
                  : step === 'confirm'
                    ? 'Review before filing'
                    : 'Filed'
              }
              onClose={close}
            />

            {step === 'compose' && (
              <ComposeStep
                text={text}
                onTextChange={setText}
                busy={busy}
                errorMsg={errorMsg}
                onCancel={close}
                onReview={handleReview}
              />
            )}

            {step === 'confirm' && (
              <ConfirmStep
                title={title}
                description={description}
                bucket={bucket}
                notify={notify}
                signedInEmail={signedInEmail}
                anonEmail={anonEmail}
                busy={busy}
                errorMsg={errorMsg}
                onTitleChange={setTitle}
                onDescriptionChange={setDescription}
                onBucketChange={setBucket}
                onNotifyChange={setNotify}
                onAnonEmailChange={setAnonEmail}
                onBack={() => {
                  setStep('compose');
                  setErrorMsg('');
                }}
                onSubmit={handleSubmit}
              />
            )}

            {step === 'success' && issueNumber !== null && (
              <SuccessStep
                issueNumber={issueNumber}
                issueUrl={issueUrl}
                onClose={close}
              />
            )}
          </div>
        </div>
      )}
    </>
  );
}

// ---------------- subcomponents ----------------

function ModalHeader({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 16,
      }}
    >
      <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: 'var(--ink)' }}>
        {title}
      </h2>
      <button
        type="button"
        onClick={onClose}
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
  );
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--muted)',
  marginBottom: 6,
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  border: '1px solid var(--line)',
  borderRadius: 8,
  background: 'var(--bg)',
  fontFamily: 'inherit',
  fontSize: 14,
  color: 'var(--ink)',
  boxSizing: 'border-box',
};

function ComposeStep({
  text,
  onTextChange,
  busy,
  errorMsg,
  onCancel,
  onReview,
}: {
  text: string;
  onTextChange: (v: string) => void;
  busy: boolean;
  errorMsg: string;
  onCancel: () => void;
  onReview: (e: React.FormEvent) => void;
}) {
  return (
    <form onSubmit={onReview}>
      <label style={labelStyle}>What's on your mind?</label>
      <textarea
        value={text}
        onChange={(e) => onTextChange(e.target.value)}
        required
        rows={6}
        autoFocus
        placeholder="Bug report, feature idea, confusion, praise: all welcome. We'll tidy it up for you."
        data-testid="feedback-text"
        style={{
          ...inputStyle,
          resize: 'vertical',
          minHeight: 120,
          marginBottom: 12,
        }}
      />
      {errorMsg && <ErrorLine msg={errorMsg} />}
      <ActionRow>
        <GhostButton onClick={onCancel}>Cancel</GhostButton>
        <PrimaryButton
          type="submit"
          disabled={busy || !text.trim()}
          testid="feedback-review"
        >
          {busy ? 'Reviewing…' : 'Review'}
        </PrimaryButton>
      </ActionRow>
    </form>
  );
}

function ConfirmStep({
  title,
  description,
  bucket,
  notify,
  signedInEmail,
  anonEmail,
  busy,
  errorMsg,
  onTitleChange,
  onDescriptionChange,
  onBucketChange,
  onNotifyChange,
  onAnonEmailChange,
  onBack,
  onSubmit,
}: {
  title: string;
  description: string;
  bucket: FeedbackBucket;
  notify: boolean;
  signedInEmail: string | null;
  anonEmail: string;
  busy: boolean;
  errorMsg: string;
  onTitleChange: (v: string) => void;
  onDescriptionChange: (v: string) => void;
  onBucketChange: (v: FeedbackBucket) => void;
  onNotifyChange: (v: boolean) => void;
  onAnonEmailChange: (v: string) => void;
  onBack: () => void;
  onSubmit: (e: React.FormEvent) => void;
}) {
  const buckets: FeedbackBucket[] = ['bug', 'feature', 'question', 'feedback'];

  return (
    <form onSubmit={onSubmit}>
      <label style={labelStyle}>Title</label>
      <input
        type="text"
        value={title}
        onChange={(e) => onTitleChange(e.target.value)}
        required
        maxLength={200}
        data-testid="feedback-title"
        style={{ ...inputStyle, marginBottom: 12 }}
      />

      <label style={labelStyle}>Description</label>
      <textarea
        value={description}
        onChange={(e) => onDescriptionChange(e.target.value)}
        required
        rows={6}
        data-testid="feedback-description"
        style={{
          ...inputStyle,
          resize: 'vertical',
          minHeight: 120,
          marginBottom: 12,
        }}
      />

      <label style={labelStyle}>Type</label>
      <div
        style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 16 }}
        role="radiogroup"
        aria-label="Feedback type"
      >
        {buckets.map((b) => {
          const active = b === bucket;
          return (
            <button
              key={b}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onBucketChange(b)}
              data-testid={`feedback-bucket-${b}`}
              style={{
                padding: '6px 12px',
                borderRadius: 999,
                border: `1px solid ${active ? 'var(--ink)' : 'var(--line)'}`,
                background: active ? 'var(--ink)' : 'var(--bg)',
                color: active ? '#fff' : 'var(--ink)',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {BUCKET_LABELS[b]}
            </button>
          );
        })}
      </div>

      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 8,
          cursor: 'pointer',
        }}
      >
        <input
          type="checkbox"
          checked={notify}
          onChange={(e) => onNotifyChange(e.target.checked)}
          data-testid="feedback-notify"
        />
        <span style={{ fontSize: 13, color: 'var(--ink)' }}>
          Email me when this is resolved
        </span>
      </label>

      {notify && signedInEmail && (
        <p
          style={{
            margin: '0 0 14px',
            fontSize: 12,
            color: 'var(--muted)',
          }}
          data-testid="feedback-email-readonly"
        >
          Updates will go to {signedInEmail}
        </p>
      )}

      {notify && !signedInEmail && (
        <input
          type="email"
          value={anonEmail}
          onChange={(e) => onAnonEmailChange(e.target.value)}
          placeholder="you@example.com"
          required
          data-testid="feedback-email"
          style={{ ...inputStyle, marginBottom: 14 }}
        />
      )}

      {errorMsg && <ErrorLine msg={errorMsg} />}

      <ActionRow>
        <GhostButton onClick={onBack} disabled={busy}>
          Back
        </GhostButton>
        <PrimaryButton type="submit" disabled={busy} testid="feedback-submit">
          {busy ? 'Filing…' : 'Submit'}
        </PrimaryButton>
      </ActionRow>
    </form>
  );
}

function SuccessStep({
  issueNumber,
  issueUrl,
  onClose,
}: {
  issueNumber: number;
  issueUrl: string;
  onClose: () => void;
}) {
  return (
    <div data-testid="feedback-success">
      <p
        style={{
          margin: 0,
          fontSize: 15,
          color: 'var(--ink)',
          padding: '8px 0 4px',
        }}
      >
        Filed{' '}
        <a
          href={issueUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: 'var(--accent, var(--ink))', fontWeight: 600 }}
          data-testid="feedback-issue-link"
        >
          #{issueNumber}
        </a>
        {' '}— you'll hear from us.
      </p>
      <p
        style={{
          margin: '6px 0 16px',
          fontSize: 13,
          color: 'var(--muted)',
        }}
      >
        Thanks for the paste. We read every report.
      </p>
      <ActionRow>
        <PrimaryButton onClick={onClose}>Close</PrimaryButton>
      </ActionRow>
    </div>
  );
}

function ActionRow({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
      {children}
    </div>
  );
}

function GhostButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: '8px 16px',
        background: 'transparent',
        border: '1px solid var(--line)',
        borderRadius: 8,
        fontSize: 13,
        color: 'var(--muted)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontFamily: 'inherit',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}

function PrimaryButton({
  children,
  onClick,
  type,
  disabled,
  testid,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  type?: 'button' | 'submit';
  disabled?: boolean;
  testid?: string;
}) {
  return (
    <button
      type={type || 'button'}
      onClick={onClick}
      disabled={disabled}
      data-testid={testid}
      style={{
        padding: '8px 16px',
        background: 'var(--ink)',
        border: 'none',
        borderRadius: 8,
        fontSize: 13,
        fontWeight: 600,
        color: '#fff',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        fontFamily: 'inherit',
      }}
    >
      {children}
    </button>
  );
}

function ErrorLine({ msg }: { msg: string }) {
  return (
    <p
      style={{
        margin: '0 0 12px',
        fontSize: 13,
        color: 'var(--warning, #c2791c)',
      }}
      role="alert"
    >
      {msg}
    </p>
  );
}
