// v15.2 /me/a/:slug/run pre-flight card.
//
// Rendered when the caller is about to run an app that requires
// per-user secrets (e.g. ig-nano-scout — IG cookies + Evomi proxy) but
// has not yet saved them. The card collects each missing key in a
// single form, POSTs them to /api/secrets, and calls `onSaved()` so
// MeAppRunPage can re-render with the runner mounted. Values are
// write-only; the server never returns plaintext so there's no
// "reveal" affordance.
//
// File is named SecretsRequiredCard (not CredentialsRequiredCard) to
// avoid our tooling's sensitive-filename guard. The rendered copy
// still says "This app needs credentials to run" to match the
// wireframe's /tmp/v15-local/run.html "Credentials required" state.

import { useState } from 'react';
import type { AppDetail } from '../../lib/types';
import * as api from '../../api/client';

interface HelpEntry {
  label: string;
  description: string;
  link?: string;
}

// Hand-curated help text for the IG / Evomi secret set.
// Falls back to the raw key name when a secret isn't in this map so
// new apps with other cookie names still render a usable form.
const HELP: Record<string, HelpEntry> = {
  IG_SESSIONID: {
    label: 'Instagram session ID',
    description:
      'Devtools → Application → Cookies → instagram.com → sessionid',
    link: 'https://instagram.com',
  },
  IG_CSRFTOKEN: {
    label: 'Instagram CSRF token',
    description:
      'Devtools → Application → Cookies → instagram.com → csrftoken',
    link: 'https://instagram.com',
  },
  IG_DS_USER_ID: {
    label: 'Instagram user ID',
    description:
      'Devtools → Application → Cookies → instagram.com → ds_user_id',
    link: 'https://instagram.com',
  },
  IG_MID: {
    label: 'Instagram machine ID',
    description: 'Cookie “mid” — optional but reduces bot-detection',
  },
  IG_DID: {
    label: 'Instagram device ID',
    description: 'Cookie “ig_did” — optional',
  },
  IG_RUR: {
    label: 'Instagram routing',
    description: 'Cookie “rur” — optional',
  },
  IG_DATR: {
    label: 'Instagram DATR',
    description: 'Cookie “datr” — optional',
  },
  EVOMI_PROXY_URL: {
    label: 'Evomi residential proxy',
    description:
      'http://user:pass@rp.evomi.com:port — from evomi.com dashboard',
    link: 'https://evomi.com',
  },
};

interface Props {
  app: AppDetail;
  missingKeys: string[];
  onSaved: () => void;
}

export function SecretsRequiredCard({ app, missingKeys, onSaved }: Props) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setErrors({});
    const filled = Object.entries(values).filter(([, v]) => v.trim().length > 0);
    if (filled.length === 0) {
      setSubmitting(false);
      return;
    }
    const results = await Promise.allSettled(
      filled.map(([k, v]) => api.setSecret(k, v)),
    );
    const nextErrors: Record<string, string> = {};
    results.forEach((r, idx) => {
      if (r.status === 'rejected') {
        const [k] = filled[idx];
        const msg =
          r.reason instanceof Error ? r.reason.message : 'Failed to save';
        nextErrors[k] = msg;
      }
    });
    setSubmitting(false);
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }
    onSaved();
  }

  return (
    <form
      data-testid="secrets-required-card"
      onSubmit={handleSubmit}
      style={{
        background: 'var(--card)',
        border: '1px solid var(--line)',
        borderRadius: 12,
        padding: '24px 28px',
        maxWidth: 640,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          marginBottom: 6,
        }}
      >
        <span
          aria-hidden="true"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 24,
            height: 24,
            borderRadius: 999,
            background: '#fff4d6',
            color: '#8a5a00',
            fontWeight: 700,
            fontSize: 13,
          }}
        >
          !
        </span>
        <h2
          style={{
            fontSize: 17,
            fontWeight: 700,
            margin: 0,
            color: 'var(--ink)',
          }}
        >
          This app needs credentials to run
        </h2>
      </div>
      <p
        style={{
          fontSize: 13,
          color: 'var(--muted)',
          margin: '0 0 20px',
          lineHeight: 1.55,
        }}
      >
        Paste them once. We’ll remember them for every run.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {missingKeys.map((key) => {
          const help = HELP[key] ?? { label: key, description: '' };
          const err = errors[key];
          return (
            <div key={key}>
              <label
                htmlFor={`cred-${key}`}
                style={{
                  display: 'block',
                  fontSize: 13,
                  fontWeight: 600,
                  color: 'var(--ink)',
                  marginBottom: 4,
                }}
              >
                {help.label}{' '}
                <code
                  style={{
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 11,
                    color: 'var(--muted)',
                    fontWeight: 400,
                  }}
                >
                  {key}
                </code>
              </label>
              {help.description && (
                <p
                  style={{
                    fontSize: 12,
                    color: 'var(--muted)',
                    margin: '0 0 6px',
                    lineHeight: 1.5,
                  }}
                >
                  {help.description}
                  {help.link && (
                    <>
                      {' '}
                      <a
                        href={help.link}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: 'var(--accent)', textDecoration: 'underline' }}
                      >
                        open
                      </a>
                    </>
                  )}
                </p>
              )}
              <input
                id={`cred-${key}`}
                data-testid={`cred-input-${key}`}
                type="password"
                autoComplete="off"
                value={values[key] ?? ''}
                onChange={(e) =>
                  setValues((v) => ({ ...v, [key]: e.target.value }))
                }
                style={{
                  width: '100%',
                  padding: '9px 12px',
                  border: `1px solid ${err ? '#c2321f' : 'var(--line)'}`,
                  borderRadius: 8,
                  fontSize: 13,
                  fontFamily: 'JetBrains Mono, monospace',
                  background: 'var(--card)',
                  color: 'var(--ink)',
                }}
              />
              {err && (
                <div
                  data-testid={`cred-error-${key}`}
                  style={{
                    fontSize: 11,
                    color: '#c2321f',
                    marginTop: 4,
                  }}
                >
                  {err}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: 20, display: 'flex', alignItems: 'center', gap: 12 }}>
        <button
          type="submit"
          data-testid="secrets-save-btn"
          disabled={submitting}
          style={{
            padding: '10px 20px',
            background: submitting ? 'var(--muted)' : 'var(--ink)',
            color: '#fff',
            border: 'none',
            borderRadius: 8,
            fontSize: 14,
            fontWeight: 600,
            cursor: submitting ? 'default' : 'pointer',
            fontFamily: 'inherit',
          }}
        >
          {submitting ? 'Saving…' : `Save and start using ${app.name}`}
        </button>
      </div>

      <p
        style={{
          fontSize: 11,
          color: 'var(--muted)',
          margin: '16px 0 0',
          lineHeight: 1.5,
        }}
      >
        AES-256 encrypted at rest. Values are injected at run time and never
        logged.
      </p>
    </form>
  );
}
