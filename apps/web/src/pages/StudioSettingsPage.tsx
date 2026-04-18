// /studio/settings — creator settings landing page. Account + password
// updates live at /me/settings (shared profile model across store + studio)
// and this page links there prominently. Studio-specific controls (API
// keys, billing) are stubbed with "Coming v1.1".

import { Link } from 'react-router-dom';
import { StudioLayout } from '../components/studio/StudioLayout';
import { useSession } from '../hooks/useSession';

export function StudioSettingsPage() {
  const { data } = useSession();
  const user = data?.user;

  return (
    <StudioLayout title="Settings · Studio">
      <div data-testid="studio-settings">
        <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--ink)', margin: '0 0 8px' }}>
          Studio settings
        </h1>
        <p
          style={{
            fontSize: 14,
            color: 'var(--muted)',
            margin: '0 0 28px',
            lineHeight: 1.55,
          }}
        >
          Creator-specific preferences. Your account profile and password
          are managed in the shared user settings.
        </p>

        <Section title="Account">
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              padding: '14px 16px',
              border: '1px solid var(--line)',
              borderRadius: 10,
              background: 'var(--card)',
              marginBottom: 10,
            }}
          >
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: 20,
                background: 'var(--accent)',
                color: '#fff',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 14,
                fontWeight: 700,
              }}
            >
              {(user?.name || user?.email || '?').charAt(0).toUpperCase()}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>
                {user?.name || user?.email || 'Local user'}
              </div>
              {user?.email && (
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>{user.email}</div>
              )}
            </div>
            <Link
              to="/me/settings"
              style={{
                padding: '8px 14px',
                fontSize: 13,
                fontWeight: 600,
                color: 'var(--ink)',
                background: 'var(--card)',
                border: '1px solid var(--line)',
                borderRadius: 8,
                textDecoration: 'none',
              }}
            >
              Edit profile →
            </Link>
          </div>
        </Section>

        <Section title="Creator API keys">
          <StubCard
            label="Coming v1.1"
            title="Personal access tokens"
            desc="Publish + manage apps from CI or the Floom CLI. Until then, use your session cookie (browser) or the OSS API token (self-host)."
          />
        </Section>

        <Section title="Billing">
          <StubCard
            label="Coming v1.1"
            title="Cloud plan"
            desc="Self-hosted Studio is free forever. Cloud billing ships with the Cloud tier (job queue, streaming, managed secrets)."
          />
        </Section>

        <Section title="Danger zone">
          <p
            style={{
              fontSize: 13,
              color: 'var(--muted)',
              margin: '0 0 10px',
              lineHeight: 1.55,
            }}
          >
            Delete individual apps from their Overview page. To delete
            your entire account (including all apps), use the shared
            account settings.
          </p>
          <Link
            to="/me/settings"
            style={{
              display: 'inline-flex',
              padding: '8px 14px',
              fontSize: 13,
              fontWeight: 600,
              color: '#c2321f',
              background: 'transparent',
              border: '1px solid #f4b7b1',
              borderRadius: 8,
              textDecoration: 'none',
            }}
          >
            Account settings →
          </Link>
        </Section>
      </div>
    </StudioLayout>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 28 }}>
      <h2
        style={{
          fontSize: 12,
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: 'var(--muted)',
          margin: '0 0 10px',
        }}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

function StubCard({
  label,
  title,
  desc,
}: {
  label: string;
  title: string;
  desc: string;
}) {
  return (
    <div
      style={{
        border: '1px dashed var(--line)',
        borderRadius: 10,
        padding: 16,
        background: 'var(--card)',
      }}
    >
      <div
        style={{
          display: 'inline-block',
          padding: '3px 8px',
          borderRadius: 4,
          background: 'var(--accent-soft)',
          color: 'var(--accent)',
          fontSize: 10,
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          marginBottom: 8,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)', marginBottom: 4 }}>
        {title}
      </div>
      <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0, lineHeight: 1.55 }}>
        {desc}
      </p>
    </div>
  );
}
