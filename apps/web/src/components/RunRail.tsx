/**
 * RunRail — v26 workspace rail for Run mode.
 *
 * v26 changes (V26-IA-SPEC §12):
 *   §12.1 — brand logo REMOVED from rail (TopBar carries it)
 *   §12.2 — [Run|Studio] mode toggle pill below workspace name
 *   §12.3/12.4 — no standalone "App store" item; "+ New app" is the single
 *                entry point; in Run mode it opens an overlay
 *   §12.5 — Docs removed from rail (moved to avatar dropdown)
 *   §12.6 — workspace settings only via identity-block click
 *   Rail: {workspace name ▾} → [Run|Studio] toggle → Apps · Runs → footer
 */

import type { CSSProperties, ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Box, Play, Plus } from 'lucide-react';
import { WorkspaceIdentityBlock } from './WorkspaceIdentityBlock';
import { ModeToggle } from './ModeToggle';
import { useMyApps } from '../hooks/useMyApps';
import { useSession, clearSession } from '../hooks/useSession';
import * as api from '../api/client';

const RAIL_WIDTH = 240;

export function RunRail() {
  const location = useLocation();
  const { apps } = useMyApps();

  return (
    <aside data-testid="run-rail" aria-label="Run navigation" style={railStyle}>
      {/* v26 §12.1: no brand here — TopBar carries the floom logo */}
      <div style={headStyle}>
        <WorkspaceIdentityBlock />
        <ModeToggle activeMode="run" />
      </div>
      <div style={bodyStyle}>
        <RailItem
          to="/run/apps"
          active={
            location.pathname === '/run/apps' ||
            location.pathname.startsWith('/run/apps/')
          }
          icon={<Box size={15} />}
          count={apps?.length}
        >
          Apps
        </RailItem>
        <RailItem
          to="/run/runs"
          active={
            location.pathname === '/run/runs' ||
            location.pathname.startsWith('/run/runs/')
          }
          icon={<Play size={15} />}
        >
          Runs
        </RailItem>

        {/* v26 §12.3/12.4: "+ New app" in Run mode → browse store (overlay in v1.1) */}
        <div style={{ marginTop: 'auto', paddingTop: 12 }}>
          <Link
            to="/apps"
            data-testid="run-rail-new-app"
            style={runPrimaryCtaStyle}
          >
            <Plus size={14} aria-hidden="true" />
            <span>New app</span>
          </Link>
        </div>
      </div>
      <RailFoot />
    </aside>
  );
}

export function RailFoot() {
  const { data, refresh } = useSession();
  const user = data?.user;
  const label = user?.name || user?.email || 'Local user';
  const initial = label.charAt(0).toUpperCase();

  async function handleSignOut() {
    try { await api.signOut(); } catch { /* ignore */ }
    clearSession();
    await refresh();
    window.location.href = '/';
  }

  return (
    <div style={footStyle}>
      <div style={avatarStyle}>
        {user?.image ? (
          <img src={user.image} alt="" style={avatarImgStyle} />
        ) : (
          initial
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={footNameStyle}>{label}</div>
        {/* v26 §12.6: settings only via workspace name click; footer shows sign-out */}
        <button
          type="button"
          data-testid="rail-foot-signout"
          onClick={() => { void handleSignOut(); }}
          style={footSignOutStyle}
        >
          Sign out
        </button>
      </div>
    </div>
  );
}

/** Kept for backward-compat imports only (StudioRail used to import Brand). */
export function Brand({ to, label, tag }: { to: string; label: string; tag?: string }) {
  return (
    <Link to={to} style={brandStyle}>
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
      {typeof count === 'number' ? (
        <span style={countStyle}>{count}</span>
      ) : null}
    </Link>
  );
}

const runPrimaryCtaStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 7,
  padding: '9px 12px',
  borderRadius: 8,
  background: 'var(--ink)',
  border: '1px solid var(--ink)',
  color: '#fff',
  textDecoration: 'none',
  fontSize: 13,
  fontWeight: 700,
  width: '100%',
  boxSizing: 'border-box' as const,
};

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
  padding: '16px 14px 12px',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

export const bodyStyle: CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  padding: '6px 10px 14px',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
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

const footSignOutStyle: CSSProperties = {
  fontSize: 11.5,
  color: 'var(--muted)',
  textDecoration: 'none',
  background: 'none',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
  fontFamily: 'inherit',
  display: 'inline',
};
