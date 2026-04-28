import type { CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { useSession } from '../hooks/useSession';

const wrapStyle: CSSProperties = {
  minHeight: 40,
  padding: '12px 16px',
  border: '1px solid var(--line)',
  borderRadius: 8,
  background: 'var(--card)',
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'center',
  gap: 2,
  textDecoration: 'none',
  cursor: 'pointer',
};

const eyebrowStyle: CSSProperties = {
  fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--muted)',
  lineHeight: 1,
};

const nameRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 6,
};

const nameStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: 'var(--ink)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  lineHeight: 1.2,
  flex: 1,
  minWidth: 0,
};

/** Subtle downward chevron indicates click → opens settings */
function ChevronDown() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0, color: 'var(--muted)' }}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

export function WorkspaceIdentityBlock() {
  const { data } = useSession();
  const workspaceName = data?.active_workspace?.name?.trim() || 'Workspace';

  return (
    <Link
      to="/settings"
      data-testid="workspace-identity-block"
      title="Workspace settings"
      style={wrapStyle}
    >
      <span style={eyebrowStyle}>Workspace</span>
      <div style={nameRowStyle}>
        <span style={nameStyle}>{workspaceName}</span>
        <ChevronDown />
      </div>
    </Link>
  );
}
