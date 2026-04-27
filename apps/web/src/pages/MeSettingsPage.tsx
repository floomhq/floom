import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { WorkspaceHeader, WorkspacePageShell } from '../components/WorkspacePageShell';
import { clearSession, refreshSession, useSession } from '../hooks/useSession';
import * as api from '../api/client';

export function AccountSettingsPage() {
  const { data: session, refresh } = useSession();
  const navigate = useNavigate();
  const [name, setName] = useState(session?.user.name || '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [deletePassword, setDeletePassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.updateAuthUser({ name: name.trim() || undefined });
      await refresh();
      setMessage('Account settings saved.');
    } catch (err) {
      setError((err as Error).message || 'Failed to save account settings');
    } finally {
      setBusy(false);
    }
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    if (!currentPassword || !newPassword) return;
    setBusy(true);
    setError(null);
    try {
      await api.changeAuthPassword({ currentPassword, newPassword, revokeOtherSessions: true });
      setCurrentPassword('');
      setNewPassword('');
      setMessage('Password updated.');
    } catch (err) {
      setError((err as Error).message || 'Failed to update password');
    } finally {
      setBusy(false);
    }
  }

  async function deleteAccount(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.deleteAuthUser({ password: deletePassword || undefined, callbackURL: '/' });
      clearSession();
      await refreshSession();
      navigate('/', { replace: true });
    } catch (err) {
      setError((err as Error).message || 'Failed to delete account');
    } finally {
      setBusy(false);
    }
  }

  return (
    <WorkspacePageShell mode="settings" title="Account settings | Floom">
      <WorkspaceHeader
        eyebrow="Account"
        title="Account settings"
        scope="Manage sign-in details and account deletion."
      />

      {message ? <div style={noticeStyle}>{message}</div> : null}
      {error ? <div role="alert" style={errorStyle}>{error}</div> : null}

      <section style={cardStyle}>
        <h2 style={h2Style}>Profile</h2>
        <form onSubmit={saveProfile} style={formStackStyle}>
          <label style={labelStyle}>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} />
          </label>
          <label style={labelStyle}>
            Email
            <input value={session?.user.email || ''} disabled style={{ ...inputStyle, color: 'var(--muted)' }} />
          </label>
          <button type="submit" disabled={busy} style={primaryButtonStyle}>Save account settings</button>
        </form>
      </section>

      <section style={cardStyle}>
        <h2 style={h2Style}>Password</h2>
        <form onSubmit={changePassword} style={formStackStyle}>
          <label style={labelStyle}>
            Current password
            <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} style={inputStyle} />
          </label>
          <label style={labelStyle}>
            New password
            <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} style={inputStyle} />
          </label>
          <button type="submit" disabled={busy || !currentPassword || !newPassword} style={primaryButtonStyle}>Update password</button>
        </form>
      </section>

      <section style={{ ...cardStyle, borderColor: '#f4b7b1' }}>
        <h2 style={h2Style}>Danger zone</h2>
        <p style={mutedStyle}>
          Delete this account and remove access to its workspace memberships. This action cannot be undone.
        </p>
        <form onSubmit={deleteAccount} style={{ ...formStackStyle, marginTop: 14 }}>
          <label style={labelStyle}>
            Confirm password
            <input type="password" value={deletePassword} onChange={(e) => setDeletePassword(e.target.value)} style={inputStyle} />
          </label>
          <button type="submit" disabled={busy} style={dangerButtonStyle}>Delete account</button>
        </form>
      </section>
    </WorkspacePageShell>
  );
}

export function MeSettingsPage() {
  return <AccountSettingsPage />;
}

const cardStyle: React.CSSProperties = {
  border: '1px solid var(--line)',
  borderRadius: 12,
  background: 'var(--card)',
  padding: 22,
  marginBottom: 18,
};

const h2Style: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 750,
  margin: '0 0 14px',
  color: 'var(--ink)',
};

const mutedStyle: React.CSSProperties = {
  fontSize: 13,
  lineHeight: 1.55,
  color: 'var(--muted)',
  margin: 0,
};

const formStackStyle: React.CSSProperties = {
  display: 'grid',
  gap: 12,
  maxWidth: 560,
};

const labelStyle: React.CSSProperties = {
  display: 'grid',
  gap: 6,
  fontSize: 12,
  fontWeight: 700,
  color: 'var(--muted)',
};

const inputStyle: React.CSSProperties = {
  border: '1px solid var(--line)',
  borderRadius: 8,
  padding: '10px 12px',
  fontSize: 13,
  color: 'var(--ink)',
  background: 'var(--bg)',
  fontFamily: 'inherit',
};

const primaryButtonStyle: React.CSSProperties = {
  justifySelf: 'start',
  border: '1px solid var(--ink)',
  borderRadius: 8,
  padding: '10px 14px',
  background: 'var(--ink)',
  color: '#fff',
  fontSize: 13,
  fontWeight: 700,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const dangerButtonStyle: React.CSSProperties = {
  ...primaryButtonStyle,
  borderColor: '#b91c1c',
  background: '#b91c1c',
};

const noticeStyle: React.CSSProperties = {
  border: '1px solid #bbf7d0',
  background: '#f0fdf4',
  color: '#166534',
  borderRadius: 8,
  padding: '10px 12px',
  fontSize: 13,
  marginBottom: 14,
};

const errorStyle: React.CSSProperties = {
  background: '#fdecea',
  border: '1px solid #f4b7b1',
  color: '#c2321f',
  borderRadius: 8,
  padding: '10px 12px',
  fontSize: 13,
  marginBottom: 14,
};
