import type { CSSProperties, ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Box, Home, KeyRound, LockKeyhole, Settings, UserRound, X } from 'lucide-react';
import { WorkspaceIdentityBlock } from './WorkspaceIdentityBlock';
import { useMyApps } from '../hooks/useMyApps';
import { useSession } from '../hooks/useSession';

interface Props {
  open: boolean;
  onClose: () => void;
  onSignOut?: () => void;
}

export function MobileDrawer({ open, onClose, onSignOut }: Props) {
  const location = useLocation();
  const { data, isAuthenticated } = useSession();
  const { apps } = useMyApps();
  if (!open) return null;

  const studioLabel = apps && apps.length > 0 ? `Apps · ${apps.length}` : 'Apps';

  return (
    <>
      <div style={scrimStyle} role="presentation" aria-hidden="true" onClick={onClose} />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Mobile navigation"
        data-testid="mobile-drawer"
        style={panelStyle}
      >
        <div style={headStyle}>
          <WorkspaceIdentityBlock />
          <button type="button" aria-label="Close menu" onClick={onClose} style={closeStyle}>
            <X size={19} aria-hidden="true" />
          </button>
        </div>
        <div style={groupsStyle}>
          <DrawerGroup label="Run">
            <DrawerLink to="/run" active={location.pathname === '/run'} onClose={onClose} icon={<Home size={15} />}>
              Overview
            </DrawerLink>
            <DrawerLink
              to="/run/apps"
              active={location.pathname === '/run/apps' || location.pathname.startsWith('/run/apps/')}
              onClose={onClose}
              icon={<Box size={15} />}
            >
              Apps
            </DrawerLink>
            <DrawerLink
              to="/run/runs"
              active={location.pathname === '/run/runs' || location.pathname.startsWith('/run/runs/')}
              onClose={onClose}
              icon={<Home size={15} />}
            >
              Runs
            </DrawerLink>
          </DrawerGroup>
          <DrawerGroup label="Studio">
            <DrawerLink to="/studio" active={location.pathname === '/studio'} onClose={onClose} icon={<Home size={15} />}>
              Home
            </DrawerLink>
            <DrawerLink to="/studio/apps" active={location.pathname === '/studio/apps'} onClose={onClose} icon={<Box size={15} />}>
              {studioLabel}
            </DrawerLink>
            <DrawerLink to="/studio/runs" active={location.pathname === '/studio/runs'} onClose={onClose} icon={<Home size={15} />}>
              All runs
            </DrawerLink>
          </DrawerGroup>
          <DrawerGroup label="Workspace settings">
            <DrawerLink
              to="/settings/byok-keys"
              active={location.pathname === '/settings/byok-keys'}
              onClose={onClose}
              icon={<LockKeyhole size={15} />}
            >
              BYOK keys
            </DrawerLink>
            <DrawerLink
              to="/settings/agent-tokens"
              active={location.pathname === '/settings/agent-tokens'}
              onClose={onClose}
              icon={<KeyRound size={15} />}
            >
              Agent tokens
            </DrawerLink>
            <DrawerLink
              to="/settings/studio"
              active={location.pathname === '/settings/studio'}
              onClose={onClose}
              icon={<Settings size={15} />}
            >
              Studio settings
            </DrawerLink>
          </DrawerGroup>
          <DrawerGroup label="Account">
            <DrawerLink
              to="/account/settings"
              active={location.pathname === '/account/settings'}
              onClose={onClose}
              icon={<UserRound size={15} />}
            >
              Account settings
            </DrawerLink>
            {!isAuthenticated ? (
              <DrawerLink to="/login" active={location.pathname === '/login'} onClose={onClose} icon={<UserRound size={15} />}>
                Sign in
              </DrawerLink>
            ) : null}
            {isAuthenticated && onSignOut ? (
              <button
                type="button"
                data-testid="mobile-drawer-signout"
                onClick={() => {
                  onClose();
                  onSignOut();
                }}
                style={buttonLinkStyle}
              >
                Sign out
              </button>
            ) : null}
          </DrawerGroup>
        </div>
        {data?.user ? (
          <div style={footStyle}>{data.user.name || data.user.email || 'Local user'}</div>
        ) : null}
      </aside>
    </>
  );
}

function DrawerGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section style={groupStyle}>
      <div style={labelStyle}>{label}</div>
      {children}
    </section>
  );
}

function DrawerLink({
  to,
  active,
  onClose,
  icon,
  children,
}: {
  to: string;
  active: boolean;
  onClose: () => void;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <Link to={to} onClick={onClose} aria-current={active ? 'page' : undefined} style={drawerLinkStyle(active)}>
      <span style={iconStyle}>{icon}</span>
      <span>{children}</span>
    </Link>
  );
}

const scrimStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(14,14,12,0.26)',
  zIndex: 80,
};

const panelStyle: CSSProperties = {
  position: 'fixed',
  inset: '0 auto 0 0',
  width: 'min(336px, calc(100vw - 34px))',
  background: 'var(--bg)',
  borderRight: '1px solid var(--line)',
  zIndex: 81,
  display: 'flex',
  flexDirection: 'column',
  boxShadow: '0 18px 48px rgba(14,14,12,0.18)',
};

const headStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr auto',
  gap: 10,
  alignItems: 'start',
  padding: 14,
  borderBottom: '1px solid var(--line)',
};

const closeStyle: CSSProperties = {
  width: 34,
  height: 34,
  borderRadius: 8,
  border: '1px solid var(--line)',
  background: 'var(--card)',
  color: 'var(--ink)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
};

const groupsStyle: CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  padding: '14px 10px',
  display: 'flex',
  flexDirection: 'column',
  gap: 18,
};

const groupStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const labelStyle: CSSProperties = {
  fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 10,
  fontWeight: 800,
  color: 'var(--muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  padding: '0 10px 3px',
};

function drawerLinkStyle(active: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 9,
    padding: '10px',
    borderRadius: 8,
    color: active ? 'var(--ink)' : 'var(--muted)',
    background: active ? 'var(--card)' : 'transparent',
    border: active ? '1px solid var(--line)' : '1px solid transparent',
    textDecoration: 'none',
    fontSize: 13,
    fontWeight: active ? 800 : 650,
  };
}

const iconStyle: CSSProperties = {
  width: 18,
  height: 18,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const buttonLinkStyle: CSSProperties = {
  ...drawerLinkStyle(false),
  width: '100%',
  border: '1px solid transparent',
  fontFamily: 'inherit',
  cursor: 'pointer',
};

const footStyle: CSSProperties = {
  borderTop: '1px solid var(--line)',
  padding: '12px 14px',
  color: 'var(--muted)',
  fontSize: 12,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
