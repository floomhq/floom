/**
 * MobileDrawer — v26 mobile navigation drawer.
 *
 * v26 changes (V26-IA-SPEC §12):
 *   - Workspace identity block (name → /settings)
 *   - Mode toggle [Run | Studio] pill
 *   - Mode-specific items (Run: Apps, Runs, + New app; Studio: Apps, Runs, + New app)
 *   - Sign out at bottom
 *   - No group labels, no standalone "Settings" group, no Docs in drawer
 *   Wire order: Workspace name → mode toggle → Apps/Runs/+ New app → Sign out
 *   Unauthenticated: Apps · Docs · Pricing · Sign in
 */

import type { CSSProperties, ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Box, Play, Plus, X } from 'lucide-react';
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

  // Determine active mode from current route; default to 'run' when on non-mode routes
  const isStudioRoute = location.pathname.startsWith('/studio');
  const activeMode: 'run' | 'studio' = isStudioRoute ? 'studio' : 'run';

  const workspaceName = data?.active_workspace?.name?.trim() || 'Workspace';

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
        {/* Header: workspace identity + close button */}
        <div style={headStyle}>
          <div style={wsIdStyle}>
            <Link
              to="/settings"
              onClick={onClose}
              title="Workspace settings"
              data-testid="mobile-drawer-ws-identity"
              style={wsLinkStyle}
            >
              <span style={wsEyebrowStyle}>Workspace</span>
              <span style={wsNameStyle}>{workspaceName} <span style={wsChevStyle}>▾</span></span>
            </Link>
          </div>
          <button type="button" aria-label="Close menu" onClick={onClose} style={closeStyle}>
            <X size={19} aria-hidden="true" />
          </button>
        </div>

        <div style={bodyStyle}>
          {isAuthenticated ? (
            <>
              {/* Mode toggle pill */}
              <div style={modeToggleStyle} role="tablist" aria-label="Workspace mode" data-testid="mobile-mode-toggle">
                <Link
                  to="/run/apps"
                  onClick={onClose}
                  role="tab"
                  aria-selected={activeMode === 'run'}
                  data-testid="mobile-mode-run"
                  style={modePillStyle(activeMode === 'run')}
                >
                  Run
                </Link>
                <Link
                  to="/studio/apps"
                  onClick={onClose}
                  role="tab"
                  aria-selected={activeMode === 'studio'}
                  data-testid="mobile-mode-studio"
                  style={modePillStyle(activeMode === 'studio')}
                >
                  Studio
                </Link>
              </div>

              {/* Mode-specific items */}
              {activeMode === 'run' ? (
                <div style={itemGroupStyle}>
                  <DrawerLink
                    to="/run/apps"
                    active={location.pathname === '/run/apps' || location.pathname.startsWith('/run/apps/')}
                    onClose={onClose}
                    icon={<Box size={15} />}
                  >
                    Apps {apps ? `· ${apps.length}` : ''}
                  </DrawerLink>
                  <DrawerLink
                    to="/run/runs"
                    active={location.pathname === '/run/runs' || location.pathname.startsWith('/run/runs/')}
                    onClose={onClose}
                    icon={<Play size={15} />}
                  >
                    Runs
                  </DrawerLink>
                  {/* §12.3/12.4: Run "+ New app" → browse store (overlay v1.1) */}
                  <DrawerLink
                    to="/apps"
                    active={location.pathname === '/apps'}
                    onClose={onClose}
                    icon={<Plus size={15} />}
                  >
                    New app
                  </DrawerLink>
                </div>
              ) : (
                <div style={itemGroupStyle}>
                  <DrawerLink
                    to="/studio/apps"
                    active={
                      location.pathname === '/studio/apps' ||
                      (location.pathname.startsWith('/studio/') &&
                        !location.pathname.startsWith('/studio/runs') &&
                        !location.pathname.startsWith('/studio/build'))
                    }
                    onClose={onClose}
                    icon={<Box size={15} />}
                  >
                    Apps
                  </DrawerLink>
                  <DrawerLink
                    to="/studio/runs"
                    active={location.pathname === '/studio/runs' || location.pathname.startsWith('/studio/runs/')}
                    onClose={onClose}
                    icon={<Play size={15} />}
                  >
                    Runs
                  </DrawerLink>
                  {/* §12.3/12.4: Studio "+ New app" → build flow */}
                  <DrawerLink
                    to="/studio/build"
                    active={location.pathname === '/studio/build'}
                    onClose={onClose}
                    icon={<Plus size={15} />}
                  >
                    New app
                  </DrawerLink>
                </div>
              )}

              <div style={dividerStyle} />

              {/* Sign out */}
              {onSignOut && (
                <button
                  type="button"
                  data-testid="mobile-drawer-signout"
                  onClick={() => {
                    onClose();
                    onSignOut();
                  }}
                  style={signOutStyle}
                >
                  Sign out
                </button>
              )}
            </>
          ) : (
            /* Unauthenticated: discovery links */
            <div style={itemGroupStyle}>
              <DrawerLink to="/apps" active={location.pathname === '/apps'} onClose={onClose} icon={<Box size={15} />}>
                Apps
              </DrawerLink>
              <DrawerLink to="/docs" active={location.pathname.startsWith('/docs')} onClose={onClose} icon={<Box size={15} />}>
                Docs
              </DrawerLink>
              <DrawerLink to="/pricing" active={location.pathname === '/pricing'} onClose={onClose} icon={<Box size={15} />}>
                Pricing
              </DrawerLink>
              <div style={dividerStyle} />
              <DrawerLink to="/login" active={location.pathname === '/login'} onClose={onClose} icon={<Box size={15} />}>
                Sign in
              </DrawerLink>
            </div>
          )}
        </div>
      </aside>
    </>
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
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 10,
  padding: '14px 14px 12px',
  borderBottom: '1px solid var(--line)',
};

const wsIdStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
};

const wsLinkStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  textDecoration: 'none',
};

const wsEyebrowStyle: CSSProperties = {
  fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--muted)',
  lineHeight: 1,
};

const wsNameStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 700,
  color: 'var(--ink)',
  lineHeight: 1.2,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const wsChevStyle: CSSProperties = {
  color: 'var(--muted)',
  fontSize: 11,
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
  flexShrink: 0,
};

const bodyStyle: CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  padding: '14px 10px',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

const modeToggleStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  background: 'var(--card)',
  border: '1px solid var(--line)',
  borderRadius: 8,
  padding: 3,
  gap: 2,
  marginBottom: 4,
};

function modePillStyle(active: boolean): CSSProperties {
  return {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '8px 12px',
    borderRadius: 6,
    fontSize: 13,
    fontWeight: active ? 700 : 500,
    color: active ? 'var(--ink)' : 'var(--muted)',
    background: active ? 'var(--bg)' : 'transparent',
    boxShadow: active ? '0 1px 2px rgba(14,14,12,0.06)' : 'none',
    border: active ? '1px solid var(--line)' : '1px solid transparent',
    textDecoration: 'none',
    lineHeight: 1,
  };
}

const itemGroupStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const dividerStyle: CSSProperties = {
  height: 1,
  background: 'var(--line)',
  margin: '4px 0',
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
    fontWeight: active ? 700 : 600,
  };
}

const iconStyle: CSSProperties = {
  width: 18,
  height: 18,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const signOutStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 9,
  padding: '10px',
  borderRadius: 8,
  color: 'var(--muted)',
  background: 'transparent',
  border: '1px solid transparent',
  fontSize: 13,
  fontWeight: 600,
  width: '100%',
  textAlign: 'left',
  fontFamily: 'inherit',
  cursor: 'pointer',
};
