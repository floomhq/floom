import type { CSSProperties, ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Box, Home, KeyRound, LockKeyhole, UserRound } from 'lucide-react';
import { Logo } from './Logo';
import { WorkspaceIdentityBlock } from './WorkspaceIdentityBlock';
import { useMyApps } from '../hooks/useMyApps';
import { useSession } from '../hooks/useSession';

const RAIL_WIDTH = 280;

export function RunRail() {
  const location = useLocation();
  const { apps } = useMyApps();

  return (
    <aside data-testid="run-rail" aria-label="Run navigation" style={railStyle}>
      <div style={headStyle}>
        <Brand to="/run" label="floom" />
        <WorkspaceIdentityBlock />
      </div>
      <div style={bodyStyle}>
        <RailSection label="Run">
          <RailItem to="/run" active={location.pathname === '/run'} icon={<Home size={15} />}>
            Overview
          </RailItem>
          <RailItem
            to="/run/apps"
            active={location.pathname === '/run/apps' || location.pathname.startsWith('/run/apps/')}
            icon={<Box size={15} />}
            count={apps?.length}
          >
            Apps
          </RailItem>
          <RailItem
            to="/run/runs"
            active={location.pathname === '/run/runs' || location.pathname.startsWith('/run/runs/')}
            icon={<Home size={15} />}
          >
            Runs
          </RailItem>
        </RailSection>
        <RailSection label="Workspace settings">
          <RailItem
            to="/settings/byok-keys"
            active={location.pathname === '/settings/byok-keys'}
            icon={<LockKeyhole size={15} />}
          >
            BYOK keys
          </RailItem>
          <RailItem
            to="/settings/agent-tokens"
            active={location.pathname === '/settings/agent-tokens'}
            icon={<KeyRound size={15} />}
          >
            Agent tokens
          </RailItem>
        </RailSection>
        <RailSection label="Account">
          <RailItem
            to="/account/settings"
            active={location.pathname === '/account/settings'}
            icon={<UserRound size={15} />}
          >
            Account settings
          </RailItem>
        </RailSection>
      </div>
      <RailFoot />
    </aside>
  );
}

export function RailFoot() {
  const { data } = useSession();
  const user = data?.user;
  const label = user?.name || user?.email || 'Local user';
  const initial = label.charAt(0).toUpperCase();

  return (
    <div style={footStyle}>
      <div style={avatarStyle}>{user?.image ? <img src={user.image} alt="" style={avatarImgStyle} /> : initial}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={footNameStyle}>{label}</div>
        <Link to="/account/settings" style={footLinkStyle}>
          Account settings
        </Link>
      </div>
    </div>
  );
}

export function Brand({ to, label, tag }: { to: string; label: string; tag?: string }) {
  return (
    <Link to={to} style={brandStyle}>
      <Logo size={20} withWordmark={false} variant="glow" />
      <span style={brandNameStyle}>{label}</span>
      {tag ? <span style={brandTagStyle}>{tag}</span> : null}
    </Link>
  );
}

export function RailSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section style={sectionStyle}>
      <div style={sectionLabelStyle}>{label}</div>
      {children}
    </section>
  );
}

export function RailItem({
  to,
  active,
  icon,
  count,
  children,
}: {
  to: string;
  active: boolean;
  icon: ReactNode;
  count?: number | null;
  children: ReactNode;
}) {
  return (
    <Link to={to} aria-current={active ? 'page' : undefined} style={itemStyle(active)}>
      <span style={iconStyle}>{icon}</span>
      <span style={itemTextStyle}>{children}</span>
      {typeof count === 'number' ? <span style={countStyle}>{count}</span> : null}
    </Link>
  );
}

export const railStyle: CSSProperties = {
  width: RAIL_WIDTH,
  flexShrink: 0,
  borderRight: '1px solid var(--line)',
  background: 'var(--bg)',
  display: 'flex',
  flexDirection: 'column',
  height: '100vh',
  position: 'sticky',
  top: 0,
  overflow: 'hidden',
};

export const headStyle: CSSProperties = {
  padding: '18px 16px 14px',
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
};

export const bodyStyle: CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  padding: '6px 10px 14px',
  display: 'flex',
  flexDirection: 'column',
  gap: 18,
};

const brandStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  color: 'var(--ink)',
  textDecoration: 'none',
  minHeight: 24,
};

const brandNameStyle: CSSProperties = {
  fontSize: 15,
  fontWeight: 800,
  lineHeight: 1,
};

const brandTagStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: 'var(--muted)',
  lineHeight: 1,
};

const sectionStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const sectionLabelStyle: CSSProperties = {
  fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 10,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  color: 'var(--muted)',
  padding: '0 10px 3px',
};

const iconStyle: CSSProperties = {
  width: 18,
  height: 18,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
};

const itemTextStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const countStyle: CSSProperties = {
  fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 10,
  color: 'var(--muted)',
  marginLeft: 'auto',
};

function itemStyle(active: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 9,
    padding: '9px 10px',
    borderRadius: 8,
    color: active ? 'var(--ink)' : 'var(--muted)',
    background: active ? 'var(--card)' : 'transparent',
    border: active ? '1px solid var(--line)' : '1px solid transparent',
    textDecoration: 'none',
    fontSize: 13,
    fontWeight: active ? 700 : 600,
  };
}

const footStyle: CSSProperties = {
  padding: '13px 14px 15px',
  borderTop: '1px solid var(--line)',
  background: 'var(--bg)',
  display: 'flex',
  alignItems: 'center',
  gap: 10,
};

const avatarStyle: CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: 999,
  background: 'var(--accent)',
  color: '#fff',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 12,
  fontWeight: 800,
  flexShrink: 0,
  overflow: 'hidden',
};

const avatarImgStyle: CSSProperties = {
  width: '100%',
  height: '100%',
  objectFit: 'cover',
};

const footNameStyle: CSSProperties = {
  fontSize: 12.5,
  fontWeight: 700,
  color: 'var(--ink)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const footLinkStyle: CSSProperties = {
  fontSize: 11.5,
  color: 'var(--muted)',
  textDecoration: 'none',
};
