import type { CSSProperties, ReactNode } from 'react';
import { PageShell } from '../PageShell';
import { useSession } from '../../hooks/useSession';

export type MeTabId = 'overview' | 'apps' | 'runs' | 'secrets' | 'settings';

interface MeLayoutProps {
  activeTab?: MeTabId;
  title?: string;
  allowSignedOutShell?: boolean;
  eyebrow?: string | null;
  heading?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  /**
   * `default` — full greeting card with avatar + eyebrow + heading.
   * `inline` — single-line greeting heading only.
   * `none`   — render no header at all. The page is responsible for
   *            its own greeting markup. Used by /me v23 (apps-led IA),
   *            which renders a `.me-greet` block inside the page so
   *            the heading sits *above* the primary nav strip in the
   *            same visual rhythm as the wireframe.
   */
  headerVariant?: 'default' | 'inline' | 'none';
  children: ReactNode;
}

const s: Record<string, CSSProperties> = {
  shell: {
    // v23 /me: bumped 1080 → 1180 to match wireframe `.me-wrap{max-width:1180px}`.
    // All /me sub-routes inherit; verified on /me/apps, /me/runs, /me/secrets,
    // /me/agent-keys, /me/settings — none of them content-clamp at <1180.
    maxWidth: 1180,
    margin: '0 auto',
    padding: '36px 32px 64px',
    width: '100%',
    boxSizing: 'border-box',
  },
  header: {
    display: 'flex',
    alignItems: 'stretch',
    gap: 18,
    minWidth: 0,
    marginBottom: 28,
    padding: '24px 24px 22px',
    borderRadius: 24,
    border: '1px solid rgba(17, 24, 39, 0.08)',
    background:
      'linear-gradient(135deg, rgba(236,253,245,0.98) 0%, rgba(255,248,240,0.98) 100%)',
    boxShadow: '0 1px 0 rgba(17, 24, 39, 0.03)',
    flexWrap: 'wrap',
  },
  identity: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 14,
    minWidth: 0,
    flex: '1 1 380px',
  },
  avatar: {
    width: 42,
    height: 42,
    borderRadius: '50%',
    objectFit: 'cover' as const,
    border: '1px solid rgba(17, 24, 39, 0.08)',
    flexShrink: 0,
    background: 'rgba(255,255,255,0.78)',
  },
  avatarInitials: {
    width: 42,
    height: 42,
    borderRadius: '50%',
    border: '1px solid rgba(17, 24, 39, 0.08)',
    background: 'rgba(255,255,255,0.78)',
    color: 'var(--ink)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 13,
    fontWeight: 700,
    letterSpacing: '0.02em',
    flexShrink: 0,
  },
  greetingStack: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 4,
    minWidth: 0,
    flex: 1,
  },
  greetingHello: {
    fontSize: 12,
    fontWeight: 600,
    color: 'rgba(17, 24, 39, 0.58)',
    lineHeight: 1.2,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
  },
  greetingName: {
    fontFamily: 'var(--font-display)',
    fontSize: 32,
    fontWeight: 800,
    letterSpacing: '-0.04em',
    lineHeight: 1.05,
    color: 'var(--ink)',
    margin: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  subtitle: {
    margin: 0,
    maxWidth: 620,
    fontSize: 14.5,
    lineHeight: 1.6,
    color: 'rgba(17, 24, 39, 0.68)',
  },
  actions: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 10,
    flex: '0 1 auto',
    marginLeft: 'auto',
    flexWrap: 'wrap',
  },
  inlineHeader: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 16,
    marginBottom: 28,
    flexWrap: 'wrap',
  },
  inlineHeading: {
    fontFamily: 'var(--font-display)',
    fontSize: 34,
    fontWeight: 800,
    letterSpacing: '-0.045em',
    lineHeight: 1.04,
    color: 'var(--ink)',
    margin: 0,
  },
};

export function MeLayout({
  title,
  allowSignedOutShell = false,
  eyebrow,
  heading,
  subtitle,
  actions,
  headerVariant = 'default',
  children,
}: MeLayoutProps) {
  const { data: session } = useSession();
  const signedOutPreview = !!session && session.cloud_mode && session.user.is_local;
  const greeting = deriveGreeting(session?.user);
  const resolvedEyebrow = eyebrow === undefined ? greeting.eyebrow : eyebrow;
  const resolvedHeading = heading || greeting.heading;

  return (
    <PageShell
      requireAuth="cloud"
      title={title || 'Me · Floom'}
      contentStyle={{ padding: 0, maxWidth: 'none', minHeight: 'auto' }}
      allowSignedOutShell={allowSignedOutShell || signedOutPreview}
      noIndex
    >
      <div data-testid="me-layout" style={s.shell}>
        {headerVariant === 'none' ? null : headerVariant === 'inline' ? (
          <header style={s.inlineHeader}>
            <h1 data-testid="me-greeting-name" style={s.inlineHeading}>
              {resolvedHeading}
            </h1>
            {actions ? <div style={s.actions}>{actions}</div> : null}
          </header>
        ) : (
          <header style={s.header}>
            <div style={s.identity}>
              <GreetingAvatar image={greeting.image} initials={greeting.initials} />
              <div style={s.greetingStack}>
                {resolvedEyebrow ? (
                  <span data-testid="me-greeting-hello" style={s.greetingHello}>
                    {resolvedEyebrow}
                  </span>
                ) : null}
                <h1 data-testid="me-greeting-name" style={s.greetingName}>
                  {resolvedHeading}
                </h1>
                {subtitle ? <p style={s.subtitle}>{subtitle}</p> : null}
              </div>
            </div>
            {actions ? <div style={s.actions}>{actions}</div> : null}
          </header>
        )}

        <div data-testid="me-tab-panel">{children}</div>
      </div>
    </PageShell>
  );
}

function deriveGreeting(user: {
  email: string | null;
  name: string | null;
  image: string | null;
} | undefined): {
  eyebrow: string;
  heading: string;
  initials: string;
  image: string | null;
} {
  const nameRaw = (user?.name ?? '').trim();
  const email = (user?.email ?? '').trim();
  const emailLocal = email.includes('@') ? email.split('@')[0] : email;
  const displayName = nameRaw || emailLocal || '';
  const firstName = firstNameFromName(nameRaw) || capitalize(emailLocal);

  return {
    eyebrow: firstName ? 'Welcome back' : 'Account',
    heading: firstName ? `Hey, ${firstName}.` : 'Welcome back.',
    initials: initialsFrom(displayName || 'there'),
    image: user?.image ?? null,
  };
}

function firstNameFromName(input: string): string {
  const clean = input.trim();
  if (!clean) return '';
  return clean.split(/\s+/)[0] || '';
}

function capitalize(input: string): string {
  if (!input) return input;
  return `${input.charAt(0).toUpperCase()}${input.slice(1)}`;
}

function initialsFrom(input: string): string {
  const parts = input
    .split(/[\s._-]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return '·';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function GreetingAvatar({
  image,
  initials,
}: {
  image: string | null;
  initials: string;
}) {
  if (image) {
    return (
      <img
        data-testid="me-greeting-avatar"
        src={image}
        alt=""
        style={s.avatar}
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.display = 'none';
        }}
      />
    );
  }

  return (
    <span
      data-testid="me-greeting-avatar-initials"
      aria-hidden="true"
      style={s.avatarInitials}
    >
      {initials}
    </span>
  );
}
