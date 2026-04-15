// W4-minimal: /me/settings — basic account settings.
//
// Four fields: display name, avatar URL, email (read-only), password.
// Plus a "delete account" section at the bottom with a confirm modal.
//
// In OSS mode most fields are read-only because there's no Better Auth
// user record to mutate; the page renders an info banner explaining that.

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageShell } from '../components/PageShell';
import { useSession } from '../hooks/useSession';

export function MeSettingsPage() {
  const { data: session, isAuthenticated } = useSession();
  const [name, setName] = useState(session?.user.name || '');
  const [password, setPassword] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [confirm, setConfirm] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const navigate = useNavigate();

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!isAuthenticated) return;
    setState('saving');
    try {
      // Better Auth doesn't expose a generic update endpoint in the plugin
      // surface we mounted, so for W4-minimal we store this as a marker in
      // the local browser storage and surface a "saved" state. The real
      // settings path (hitting /auth/update-user) is wired in W4.1 when we
      // ship the cloud writer endpoint.
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(
          'floom-settings-override',
          JSON.stringify({ name, avatarUrl }),
        );
      }
      setState('saved');
      setTimeout(() => setState('idle'), 1500);
    } catch {
      setState('error');
    }
  }

  async function handleDelete() {
    if (confirmText !== session?.user.email) return;
    alert('Delete-account is wired in cloud mode only. Ask support to delete your account.');
    setConfirm(false);
    navigate('/');
  }

  return (
    <PageShell requireAuth="cloud" title="Settings | Floom">
      <div data-testid="settings-page" style={{ maxWidth: 540 }}>
        <h1 style={{ fontSize: 26, fontWeight: 700, margin: '0 0 6px', color: 'var(--ink)' }}>
          Account settings
        </h1>
        <p style={{ fontSize: 14, color: 'var(--muted)', margin: '0 0 28px' }}>
          Update your profile and password.
        </p>

        {!isAuthenticated && (
          <div
            style={{
              background: '#fff8e6',
              border: '1px solid #f4e0a5',
              color: '#755a00',
              borderRadius: 10,
              padding: '12px 16px',
              fontSize: 13,
              marginBottom: 20,
            }}
          >
            You're using the local account (OSS mode). Settings are read-only
            until cloud auth is enabled on this server.
          </div>
        )}

        <form onSubmit={handleSave}>
          <Label>Display name</Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={!isAuthenticated}
            placeholder="Ada Lovelace"
            data-testid="settings-name"
          />

          <Label>Avatar URL (optional)</Label>
          <Input
            value={avatarUrl}
            onChange={(e) => setAvatarUrl(e.target.value)}
            disabled={!isAuthenticated}
            placeholder="https://..."
            data-testid="settings-avatar"
          />

          <Label>Email</Label>
          <Input
            value={session?.user.email || '(local)'}
            readOnly
            disabled
            data-testid="settings-email"
          />

          <Label>New password</Label>
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={!isAuthenticated}
            placeholder="Leave blank to keep current"
            data-testid="settings-password"
          />

          <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
            <button
              type="submit"
              disabled={!isAuthenticated || state === 'saving'}
              data-testid="settings-save"
              style={{
                padding: '10px 18px',
                background: 'var(--ink)',
                color: '#fff',
                border: 'none',
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 600,
                cursor: isAuthenticated ? 'pointer' : 'not-allowed',
                fontFamily: 'inherit',
                opacity: isAuthenticated ? 1 : 0.5,
              }}
            >
              {state === 'saving' ? 'Saving...' : state === 'saved' ? 'Saved' : 'Save changes'}
            </button>
          </div>
        </form>

        <div
          style={{
            marginTop: 48,
            padding: 24,
            background: 'var(--card)',
            border: '1px solid #f4b7b1',
            borderRadius: 12,
          }}
        >
          <h3 style={{ fontSize: 14, fontWeight: 700, color: '#c2321f', margin: '0 0 6px' }}>
            Delete account
          </h3>
          <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 16px', lineHeight: 1.55 }}>
            Permanently delete your account and everything associated with it. This cannot be undone.
          </p>
          <button
            type="button"
            onClick={() => setConfirm(true)}
            data-testid="settings-delete-trigger"
            disabled={!isAuthenticated}
            style={{
              padding: '8px 14px',
              background: 'transparent',
              color: '#c2321f',
              border: '1px solid #f4b7b1',
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 600,
              cursor: isAuthenticated ? 'pointer' : 'not-allowed',
              fontFamily: 'inherit',
              opacity: isAuthenticated ? 1 : 0.5,
            }}
          >
            Delete my account
          </button>
        </div>

        {confirm && (
          <div
            role="dialog"
            aria-modal="true"
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
            onClick={() => setConfirm(false)}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                background: 'var(--card)',
                borderRadius: 12,
                padding: 24,
                maxWidth: 440,
                width: '100%',
              }}
            >
              <h3 style={{ margin: '0 0 10px', fontSize: 16, color: 'var(--ink)' }}>
                Delete account?
              </h3>
              <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--muted)', lineHeight: 1.55 }}>
                Type your email <code style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12 }}>{session?.user.email}</code> to confirm.
              </p>
              <Input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                data-testid="settings-delete-confirm"
              />
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
                <button
                  type="button"
                  onClick={() => setConfirm(false)}
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
                  type="button"
                  onClick={handleDelete}
                  disabled={confirmText !== session?.user.email}
                  style={{
                    padding: '8px 16px',
                    background: '#c2321f',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 8,
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: confirmText === session?.user.email ? 'pointer' : 'not-allowed',
                    fontFamily: 'inherit',
                    opacity: confirmText === session?.user.email ? 1 : 0.6,
                  }}
                >
                  Delete forever
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </PageShell>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <label
      style={{
        display: 'block',
        fontSize: 12,
        fontWeight: 600,
        color: 'var(--muted)',
        marginBottom: 6,
        marginTop: 14,
      }}
    >
      {children}
    </label>
  );
}

function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      style={{
        width: '100%',
        padding: '10px 12px',
        border: '1px solid var(--line)',
        borderRadius: 8,
        background: props.disabled ? 'var(--bg)' : 'var(--card)',
        fontSize: 14,
        color: 'var(--ink)',
        fontFamily: 'inherit',
        boxSizing: 'border-box',
        ...(props.style || {}),
      }}
    />
  );
}
