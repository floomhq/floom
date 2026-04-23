/**
 * BYOKModal — bring-your-own-key prompt for the 3 launch demo apps that
 * consume GEMINI_API_KEY (lead-scorer, competitor-analyzer, resume-screener).
 *
 * The server gates anon runs at 5 per IP per 24h (see
 * apps/server/src/lib/byok-gate.ts). On the 6th attempt /api/run returns
 * HTTP 429 with `{ error: 'byok_required', slug, usage, limit, get_key_url,
 * message }`. This modal catches that payload: user pastes their Gemini key,
 * we save it to localStorage under `floom_user_gemini_key`, and the next
 * startRun() attaches it as `X-User-Api-Key` so the server uses their key
 * for that one run (never logged, never persisted).
 *
 * Minimal surface by design — no tabs, no account wall, no upsell. Under
 * the hood it's just `writeUserGeminiKey(...)` + a retry. Refusing to go
 * beyond that is the whole point of the launch-week product rule.
 */
import { useEffect, useState } from 'react';
import { writeUserGeminiKey, clearUserGeminiKey } from '../api/client';
import { SecretInput } from './forms/SecretInput';

export interface BYOKModalProps {
  open: boolean;
  /**
   * Why the modal is open. Changes the heading + copy, nothing else —
   * save path and storage are identical. Added 2026-04-25 so FreeRunsStrip
   * can open the modal before the user hits 429.
   *   - `exhausted` (default): post-429, "Free runs used up"
   *   - `proactive`: user clicked "Use your own key" while budget remains
   */
  mode?: 'exhausted' | 'proactive';
  /**
   * Parsed payload from the 429 response body. Fields come straight from
   * apps/server/src/lib/byok-gate.ts::byokRequiredResponse. Safe to pass
   * null — the modal renders sensible fallbacks.
   */
  payload?: {
    slug?: string;
    usage?: number;
    limit?: number;
    get_key_url?: string;
    message?: string;
  } | null;
  onClose: () => void;
  /**
   * Called after the user has saved a key. The caller decides what to do
   * next: in `exhausted` mode RunSurface auto-retries the run; in
   * `proactive` mode it just closes the modal — the user meant to pre-
   * configure, not to re-run a failed request.
   */
  onSaved: () => void;
}

export function BYOKModal({
  open,
  mode = 'exhausted',
  payload,
  onClose,
  onSaved,
}: BYOKModalProps) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setValue('');
      setError(null);
    }
  }, [open]);

  if (!open) return null;

  const getKeyUrl = payload?.get_key_url || 'https://aistudio.google.com/app/apikey';
  const slug = payload?.slug || 'this app';
  const limit = payload?.limit ?? 5;

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = value.trim();
    if (trimmed.length < 20) {
      setError('That does not look like a valid Gemini API key.');
      return;
    }
    writeUserGeminiKey(trimmed);
    setError(null);
    onSaved();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Add your Gemini API key"
      data-testid="byok-modal"
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
          maxWidth: 480,
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
            data-testid="byok-modal-heading"
            style={{ margin: 0, fontSize: 18, fontWeight: 700, color: 'var(--ink)' }}
          >
            {mode === 'proactive' ? 'Use your own Gemini key' : 'Free runs used up'}
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

        <p
          style={{
            margin: '0 0 14px',
            fontSize: 14,
            lineHeight: 1.55,
            color: 'var(--muted)',
          }}
        >
          {mode === 'proactive' ? (
            <>
              Bring your own Gemini API key to run <code>{slug}</code>{' '}
              without the {limit}-runs-per-day free cap. The key stays in
              your browser — we never log or store it, and it's only sent
              with your next run on this app.
            </>
          ) : (
            <>
              You used all {limit} free runs of <code>{slug}</code> today.
              Paste your own Gemini API key to keep going — it stays in
              your browser, we never log or store it.
            </>
          )}
        </p>

        <form onSubmit={handleSave}>
          <label
            style={{
              display: 'block',
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--muted)',
              marginBottom: 6,
            }}
          >
            Gemini API key
          </label>
          <SecretInput
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (error) setError(null);
            }}
            autoFocus
            placeholder="AIza..."
            data-testid="byok-key-input"
            autoComplete="off"
            spellCheck={false}
            style={{
              width: '100%',
              padding: 12,
              border: `1px solid ${error ? 'var(--danger, #e5484d)' : 'var(--line)'}`,
              borderRadius: 8,
              background: 'var(--bg)',
              color: 'var(--ink)',
              fontFamily: "'JetBrains Mono', ui-monospace, monospace",
              fontSize: 13,
              boxSizing: 'border-box',
              marginBottom: error ? 6 : 14,
            }}
          />
          {error && (
            <div
              data-testid="byok-error"
              style={{
                fontSize: 12,
                color: 'var(--danger, #e5484d)',
                marginBottom: 10,
              }}
            >
              {error}
            </div>
          )}

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              justifyContent: 'space-between',
              flexWrap: 'wrap',
            }}
          >
            <a
              href={getKeyUrl}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="byok-get-key-link"
              style={{
                fontSize: 13,
                color: 'var(--accent)',
                textDecoration: 'underline',
              }}
            >
              Get a free key →
            </a>

            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                onClick={() => {
                  clearUserGeminiKey();
                  onClose();
                }}
                style={{
                  background: 'transparent',
                  color: 'var(--muted)',
                  border: '1px solid var(--line)',
                  borderRadius: 8,
                  padding: '9px 14px',
                  fontSize: 13,
                  fontWeight: 500,
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                type="submit"
                data-testid="byok-save"
                style={{
                  background: 'var(--accent)',
                  color: '#fff',
                  border: '1px solid var(--accent)',
                  borderRadius: 8,
                  padding: '9px 16px',
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Save key
              </button>
            </div>
          </div>
        </form>

        <p
          style={{
            margin: '14px 0 0',
            fontSize: 12,
            color: 'var(--muted)',
            lineHeight: 1.5,
          }}
        >
          The key is kept in your browser's localStorage and sent only with
          your next run on <code>{slug}</code>. Remove it any time in
          settings.
        </p>
      </div>
    </div>
  );
}
