/**
 * ModeToggle — [Run | Studio] pill below workspace name in the left rail.
 *
 * v26-IA-SPEC §2a: toggle is BELOW workspace name (workspace > mode hierarchy).
 * §2b: NOT shown on public pages.
 */

import type { CSSProperties } from 'react';
import { Link } from 'react-router-dom';

interface Props {
  activeMode: 'run' | 'studio';
}

const pillStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  background: 'var(--card)',
  border: '1px solid var(--line)',
  borderRadius: 8,
  padding: 3,
  gap: 2,
};

function segmentStyle(active: boolean): CSSProperties {
  return {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '6px 10px',
    borderRadius: 6,
    fontSize: 12,
    fontWeight: active ? 700 : 500,
    color: active ? 'var(--ink)' : 'var(--muted)',
    background: active ? 'var(--bg)' : 'transparent',
    boxShadow: active ? '0 1px 2px rgba(14,14,12,0.06)' : 'none',
    border: active ? '1px solid var(--line)' : '1px solid transparent',
    textDecoration: 'none',
    lineHeight: 1,
    transition: 'color 0.1s, background 0.1s',
    whiteSpace: 'nowrap' as const,
  };
}

export function ModeToggle({ activeMode }: Props) {
  return (
    <div style={pillStyle} data-testid="mode-toggle" role="tablist" aria-label="Workspace mode">
      <Link
        to="/run/apps"
        role="tab"
        aria-selected={activeMode === 'run'}
        data-testid="mode-toggle-run"
        style={segmentStyle(activeMode === 'run')}
      >
        Run
      </Link>
      <Link
        to="/studio/apps"
        role="tab"
        aria-selected={activeMode === 'studio'}
        data-testid="mode-toggle-studio"
        style={segmentStyle(activeMode === 'studio')}
      >
        Studio
      </Link>
    </div>
  );
}
