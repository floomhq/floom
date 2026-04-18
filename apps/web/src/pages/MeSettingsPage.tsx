// W4-minimal: /me/settings — account settings wired to Better Auth 1.6.3.
//
// Three sections:
//   1. Profile  — display name + avatar URL. POST /auth/update-user.
//   2. Password — current + new + confirm. POST /auth/change-password.
//   3. Delete   — password-gated confirm modal. POST /auth/delete-user.
//
// Email is read-only — Better Auth has /auth/change-email, but it requires
// a verification flow we don't yet ship email delivery for. Left out of
// W4-minimal intentionally and flagged on the UI.
//
// In OSS mode the Better Auth endpoints are not mounted, so everything is
// read-only and a banner explains why. The page never falls back to
// localStorage or alert() stubs.

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageShell } from '../components/PageShell';
import { useSession, refreshSession, clearSession } from '../hooks/useSession';
import * as api from '../api/client';

/**
 * Card wrapper: restores visual structure so /me/settings matches the Store
 * consumer chrome (same treatment the run surface, hero tiles, and meta
 * cards use). Prior version rendered bare forms with section rules only,
 * leaving ~50% of the viewport empty and no visible signed-in state.
 */
function SettingsCard({
  id,
  children,
  danger = false,
}: {
  id?: string;
  children: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <section
      data-testid={id}
      style={{
        background: 'var(--card)',
        border: `1px solid ${danger ? '#f4b7b1' : 'var(--line)'}`,
        borderRadius: 14,
        padding: '22px 24px',
        marginBottom: 18,
        boxSizing: 'border-box',
      }}
    >
      {children}
    </section>
  );
}

type FieldState = 'idle' | 'saving' | 'saved' | 'error';

export function MeSettingsPage() {
  const { data: session, isAuthenticated } = useSession();
  const navigate = useNavigate();

  // Profile section state. The initial render may land before /api/session/me
  // resolves (SPA boot path), so we also sync from `session` whenever it
  // updates. Track a `dirty` flag per field so we stop clobbering user
  // edits once they've typed something.
  const [name, setName] = useState<string>(session?.user.name || '');
  const [avatarUrl, setAvatarUrl] = useState<string>(session?.user.image || '');
  const [nameDirty, setNameDirty] = useState(false);
  const [avatarDirty, setAvatarDirty] = useState(false);
  const [profileState, setProfileState] = useState<FieldState>('idle');
  const [profileError, setProfileError] = useState<string>('');

  // Re-seed form fields from the session whenever it changes, but only
  // for fields the user hasn't started editing. This covers the race
  // where the page mounts before /api/session/me resolves and also
  // handles post-save re-syncs when refreshSession() updates the cache.
  useEffect(() => {
    if (!session) return;
    if (!nameDirty) setName(session.user.name || '');
    if (!avatarDirty) setAvatarUrl(session.user.image || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user.name, session?.user.image]);

  // Password section state.
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordState, setPasswordState] = useState<FieldState>('idle');
  const [passwordError, setPasswordError] = useState<string>('');

  // Delete-account modal state.
  const [confirm, setConfirm] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteState, setDeleteState] = useState<FieldState>('idle');
  const [deleteError, setDeleteError] = useState<string>('');

  async function handleProfileSave(e: React.FormEvent) {
    e.preventDefault();
    if (!isAuthenticated) return;
    setProfileState('saving');
    setProfileError('');
    try {
      // Only send fields the user actually touched. `image: null` clears the
      // avatar in Better Auth; undefined leaves it alone.
      const body: { name?: string; image?: string | null } = {};
      if (name !== (session?.user.name || '')) body.name = name;
      if (avatarUrl !== (session?.user.image || '')) {
        body.image = avatarUrl ? avatarUrl : null;
      }
      if (Object.keys(body).length === 0) {
        setProfileState('saved');
        setTimeout(() => setProfileState('idle'), 1500);
        return;
      }
      await api.updateAuthUser(body);
      await refreshSession();
      // Reset dirty flags so the useEffect re-seeds from the freshly
      // fetched session payload — otherwise the form still displays the
      // pre-save values on a non-reload session refresh.
      setNameDirty(false);
      setAvatarDirty(false);
      setProfileState('saved');
      setTimeout(() => setProfileState('idle'), 1500);
    } catch (err) {
      setProfileState('error');
      const e = err as api.ApiError;
      setProfileError(e.message || 'Could not save profile.');
    }
  }

  async function handlePasswordSave(e: React.FormEvent) {
    e.preventDefault();
    if (!isAuthenticated) return;
    setPasswordError('');
    if (newPassword.length < 8) {
      setPasswordState('error');
      setPasswordError('New password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordState('error');
      setPasswordError('New password and confirmation do not match.');
      return;
    }
    setPasswordState('saving');
    try {
      await api.changeAuthPassword({
        currentPassword,
        newPassword,
        revokeOtherSessions: true,
      });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordState('saved');
      setTimeout(() => setPasswordState('idle'), 1500);
    } catch (err) {
      setPasswordState('error');
      const e = err as api.ApiError;
      if (e.status === 401 || e.status === 400) {
        setPasswordError(e.message || 'Current password incorrect.');
      } else {
        setPasswordError(e.message || 'Could not change password.');
      }
    }
  }

  async function handleDelete() {
    if (!isAuthenticated) return;
    setDeleteState('saving');
    setDeleteError('');
    try {
      await api.deleteAuthUser({ password: deletePassword });
      clearSession();
      await refreshSession();
      setConfirm(false);
      navigate('/', { replace: true });
    } catch (err) {
      setDeleteState('error');
      const e = err as api.ApiError;
      if (e.status === 401 || e.status === 400) {
        setDeleteError(e.message || 'Password incorrect.');
      } else {
        setDeleteError(e.message || 'Could not delete account.');
      }
    }
  }

  // Round 2 polish: /me/settings previously rendered bare, unstyled forms
  // with ~50% of the viewport empty and no visible way to sign out. The
  // prominent "Sign out" action is also missing on the topbar for many
  // signed-in states, so users would orphan in their account. This adds a
  // clear Sign out button at the top of the page, wraps each section in
  // the card chrome used across the store surface, and keeps the existing
  // form logic intact.
  async function handleSignOut() {
    try {
      await api.signOut();
    } catch {
      // Ignore network errors — still clear client state so the user is
      // signed out locally even if the backend call failed.
    }
    clearSession();
    await refreshSession();
    navigate('/', { replace: true });
  }

  return (
    <PageShell requireAuth="cloud" title="Settings | Floom">
      <div data-testid="settings-page" style={{ maxWidth: 620 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 16,
            flexWrap: 'wrap',
            marginBottom: 24,
          }}
        >
          <div>
            <h1 style={{ fontSize: 26, fontWeight: 700, margin: '0 0 6px', color: 'var(--ink)' }}>
              Account settings
            </h1>
            <p style={{ fontSize: 14, color: 'var(--muted)', margin: 0 }}>
              Update your profile, change your password, or sign out.
            </p>
          </div>
          <button
            type="button"
            onClick={handleSignOut}
            disabled={!isAuthenticated}
            data-testid="settings-signout"
            style={{
              padding: '9px 16px',
              background: 'var(--card)',
              color: 'var(--ink)',
              border: '1px solid var(--line)',
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 600,
              cursor: isAuthenticated ? 'pointer' : 'not-allowed',
              fontFamily: 'inherit',
              opacity: isAuthenticated ? 1 : 0.5,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              flexShrink: 0,
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Sign out
          </button>
        </div>

        {!isAuthenticated && (
          <div
            data-testid="settings-oss-banner"
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
            You&apos;re using the local account (OSS mode). Settings are read-only
            until cloud auth is enabled on this server.
          </div>
        )}

        {/* ---------- Profile card ---------- */}
        <SettingsCard id="settings-card-profile">
        <form onSubmit={handleProfileSave} data-testid="settings-profile-form">
          <SectionHeading>Profile</SectionHeading>

          <Label>Display name</Label>
          <Input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setNameDirty(true);
            }}
            disabled={!isAuthenticated}
            placeholder="Ada Lovelace"
            data-testid="settings-name"
          />

          <Label>Avatar URL (optional)</Label>
          <Input
            value={avatarUrl}
            onChange={(e) => {
              setAvatarUrl(e.target.value);
              setAvatarDirty(true);
            }}
            disabled={!isAuthenticated}
            placeholder="https://avatars.example.com/ada.png"
            data-testid="settings-avatar"
          />

          <Label>Email (read-only)</Label>
          <Input
            value={session?.user.email || '(local)'}
            readOnly
            disabled
            data-testid="settings-email"
          />

          {profileState === 'error' && profileError && (
            <p data-testid="settings-profile-error" style={errorTextStyle}>
              {profileError}
            </p>
          )}

          <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
            <button
              type="submit"
              disabled={!isAuthenticated || profileState === 'saving'}
              data-testid="settings-save"
              style={primaryButtonStyle(isAuthenticated)}
            >
              {profileState === 'saving'
                ? 'Saving...'
                : profileState === 'saved'
                ? 'Saved'
                : 'Save profile'}
            </button>
          </div>
        </form>
        </SettingsCard>

        {/* ---------- Password card ---------- */}
        <SettingsCard id="settings-card-password">
        <form
          onSubmit={handlePasswordSave}
          data-testid="settings-password-form"
        >
          <SectionHeading>Change password</SectionHeading>

          <Label>Current password</Label>
          <Input
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            disabled={!isAuthenticated}
            autoComplete="current-password"
            data-testid="settings-current-password"
          />

          <Label>New password</Label>
          <Input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            disabled={!isAuthenticated}
            placeholder="At least 8 characters"
            autoComplete="new-password"
            data-testid="settings-new-password"
          />

          <Label>Confirm new password</Label>
          <Input
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            disabled={!isAuthenticated}
            autoComplete="new-password"
            data-testid="settings-confirm-password"
          />

          {passwordState === 'error' && passwordError && (
            <p data-testid="settings-password-error" style={errorTextStyle}>
              {passwordError}
            </p>
          )}

          <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
            <button
              type="submit"
              disabled={
                !isAuthenticated ||
                passwordState === 'saving' ||
                !currentPassword ||
                !newPassword ||
                !confirmPassword
              }
              data-testid="settings-password-save"
              style={primaryButtonStyle(
                isAuthenticated && !!currentPassword && !!newPassword && !!confirmPassword,
              )}
            >
              {passwordState === 'saving'
                ? 'Changing...'
                : passwordState === 'saved'
                ? 'Password changed'
                : 'Change password'}
            </button>
          </div>
        </form>
        </SettingsCard>

        {/* ---------- Danger zone card ---------- */}
        <SettingsCard id="settings-card-danger" danger>
          <h3 style={{ fontSize: 14, fontWeight: 700, color: '#c2321f', margin: '0 0 6px' }}>
            Danger zone
          </h3>
          <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 16px', lineHeight: 1.55 }}>
            Permanently delete your account and everything associated with it. This cannot be undone.
          </p>
          <button
            type="button"
            onClick={() => {
              setConfirm(true);
              setDeletePassword('');
              setDeleteState('idle');
              setDeleteError('');
            }}
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
        </SettingsCard>

        {confirm && (
          <div
            role="dialog"
            aria-modal="true"
            data-testid="settings-delete-modal"
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
                This permanently deletes <code style={codeStyle}>{session?.user.email}</code> and
                all associated data. Enter your password to confirm.
              </p>
              <Input
                type="password"
                value={deletePassword}
                onChange={(e) => setDeletePassword(e.target.value)}
                placeholder="Your password"
                autoComplete="current-password"
                data-testid="settings-delete-password"
              />
              {deleteState === 'error' && deleteError && (
                <p data-testid="settings-delete-error" style={{ ...errorTextStyle, marginTop: 10 }}>
                  {deleteError}
                </p>
              )}
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
                  disabled={!deletePassword || deleteState === 'saving'}
                  data-testid="settings-delete-confirm"
                  style={{
                    padding: '8px 16px',
                    background: '#c2321f',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 8,
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: deletePassword && deleteState !== 'saving' ? 'pointer' : 'not-allowed',
                    fontFamily: 'inherit',
                    opacity: deletePassword && deleteState !== 'saving' ? 1 : 0.6,
                  }}
                >
                  {deleteState === 'saving' ? 'Deleting...' : 'Delete forever'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </PageShell>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2
      style={{
        fontSize: 15,
        fontWeight: 700,
        color: 'var(--ink)',
        margin: '0 0 12px',
        paddingBottom: 8,
        borderBottom: '1px solid var(--line)',
      }}
    >
      {children}
    </h2>
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

function primaryButtonStyle(active: boolean): React.CSSProperties {
  return {
    padding: '10px 18px',
    background: 'var(--ink)',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    cursor: active ? 'pointer' : 'not-allowed',
    fontFamily: 'inherit',
    opacity: active ? 1 : 0.5,
  };
}

const errorTextStyle: React.CSSProperties = {
  margin: '10px 0 0',
  fontSize: 13,
  color: '#c2791c',
};

const codeStyle: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 12,
};
