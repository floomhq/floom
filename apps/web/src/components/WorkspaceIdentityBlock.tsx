import type { CSSProperties } from 'react';
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

const nameStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: 'var(--ink)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  lineHeight: 1.2,
};

export function WorkspaceIdentityBlock() {
  const { data } = useSession();
  const workspaceName = data?.active_workspace?.name?.trim() || 'Workspace';

  return (
    <div data-testid="workspace-identity-block" style={wrapStyle}>
      <span style={eyebrowStyle}>Workspace</span>
      <span style={nameStyle}>{workspaceName}</span>
    </div>
  );
}
