// Workspace switcher for the MeRail footer.
//
// Behaviour:
// - Hidden entirely when the user has only one workspace (keeps the rail
//   clean for the 90% case where workspaces are a single-tenant default).
// - Click the trigger to open a popover listing every workspace the user
//   is a member of. Selecting one calls POST /api/session/switch-workspace,
//   refreshes the session cache, and invalidates workspace-scoped data
//   (apps list). Cache refresh is what makes the sidebar re-render with
//   the new scope.
// - While a switch is in flight, the trigger shows a spinner and the list
//   is disabled so double-clicks can't fire two switches.
// - Errors are shown inline under the list. Retry by clicking again.
//
// Styling matches the rest of MeRail (wireframe.css custom props, Floom
// green accent, no emojis, no colored left borders, no gradients).

import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import * as api from '../../api/client';
import { refreshSession } from '../../hooks/useSession';
import { refreshMyApps } from '../../hooks/useMyApps';
import type { SessionWorkspace } from '../../lib/types';

interface Props {
  active: SessionWorkspace;
  workspaces: SessionWorkspace[];
}

export function WorkspaceSwitcher({ active, workspaces }: Props) {
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on outside click so the popover behaves like every other menu
  // in the app (TopBar uses the same pattern).
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  // Escape closes the popover; mirrors TopBar's account menu a11y.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Single-workspace users never see this UI. Don't render the trigger at
  // all so the footer doesn't grow a dead control.
  if (!workspaces || workspaces.length <= 1) return null;

  async function handleSelect(id: string) {
    if (switching) return;
    if (id === active.id) {
      setOpen(false);
      return;
    }
    setSwitching(id);
    setError(null);
    try {
      await api.switchWorkspace(id);
      // Refresh session first so `active_workspace` updates everywhere
      // that reads `useSession()`. Then refresh the apps list so the
      // sidebar's "Your apps" re-scopes to the new workspace.
      await refreshSession();
      await refreshMyApps();
      setOpen(false);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'Could not switch workspace';
      setError(msg);
    } finally {
      setSwitching(null);
    }
  }

  return (
    <div ref={rootRef} style={{ position: 'relative', marginBottom: 8 }}>
      <button
        type="button"
        data-testid="me-rail-workspace-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        disabled={switching !== null}
        style={triggerStyle(switching !== null)}
      >
        <SwitchIcon size={14} />
        <span
          style={{
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            textAlign: 'left',
            fontWeight: 600,
          }}
        >
          {active.name}
        </span>
        {switching ? (
          <Spinner size={12} />
        ) : (
          <ChevronIcon size={12} open={open} />
        )}
      </button>
      {open && (
        <div
          role="menu"
          data-testid="me-rail-workspace-menu"
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 6px)',
            left: 0,
            right: 0,
            background: 'var(--card)',
            border: '1px solid var(--line)',
            borderRadius: 8,
            boxShadow: '0 8px 24px rgba(0,0,0,0.08)',
            padding: 4,
            zIndex: 50,
            maxHeight: 260,
            overflowY: 'auto',
          }}
        >
          {workspaces.map((ws) => {
            const isActive = ws.id === active.id;
            const isSwitchingThis = switching === ws.id;
            return (
              <button
                key={ws.id}
                type="button"
                role="menuitem"
                data-testid={`me-rail-workspace-option-${ws.slug}`}
                data-active={isActive ? 'true' : 'false'}
                onClick={() => handleSelect(ws.id)}
                disabled={switching !== null}
                style={optionStyle(isActive, switching !== null)}
              >
                <span
                  style={{
                    flex: 1,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {ws.name}
                </span>
                <span
                  style={{
                    fontSize: 10,
                    color: 'var(--muted)',
                    textTransform: 'lowercase',
                    letterSpacing: '0.02em',
                  }}
                >
                  {ws.role}
                </span>
                {isSwitchingThis && <Spinner size={10} />}
                {isActive && !isSwitchingThis && (
                  <CheckIcon size={12} />
                )}
              </button>
            );
          })}
          {error && (
            <div
              role="alert"
              data-testid="me-rail-workspace-error"
              style={{
                padding: '8px 10px',
                fontSize: 11,
                color: '#b42318',
                borderTop: '1px solid var(--line)',
                marginTop: 4,
              }}
            >
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function triggerStyle(disabled: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    padding: '7px 10px',
    background: 'var(--card)',
    border: '1px solid var(--line)',
    borderRadius: 8,
    fontSize: 12,
    color: 'var(--ink)',
    cursor: disabled ? 'wait' : 'pointer',
    opacity: disabled ? 0.7 : 1,
    fontFamily: 'inherit',
  };
}

function optionStyle(isActive: boolean, disabled: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    padding: '7px 10px',
    background: isActive ? 'var(--accent-soft)' : 'transparent',
    border: 'none',
    borderRadius: 6,
    fontSize: 13,
    color: isActive ? 'var(--accent)' : 'var(--ink)',
    fontWeight: isActive ? 600 : 500,
    cursor: disabled ? 'wait' : 'pointer',
    fontFamily: 'inherit',
    textAlign: 'left',
  };
}

function SwitchIcon({ size = 14 }: { size?: number }) {
  // Lucide `arrow-left-right` — two horizontal arrows pointing opposite
  // ways. Semantically clean for "swap between workspaces" without
  // implying hierarchy (folder/grid icons suggest containment).
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0, color: 'var(--muted)' }}
    >
      <path d="M8 3L4 7l4 4" />
      <path d="M4 7h16" />
      <path d="M16 21l4-4-4-4" />
      <path d="M20 17H4" />
    </svg>
  );
}

function ChevronIcon({ size = 12, open }: { size?: number; open: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{
        flexShrink: 0,
        color: 'var(--muted)',
        transform: open ? 'rotate(180deg)' : undefined,
        transition: 'transform 0.15s',
      }}
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function CheckIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0, color: 'var(--accent)' }}
    >
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

function Spinner({ size = 12 }: { size?: number }) {
  // Uses the global `floom-spin` keyframe defined in styles/globals.css
  // so we don't ship a second copy of the rotate animation.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      aria-hidden="true"
      style={{
        flexShrink: 0,
        color: 'var(--muted)',
        animation: 'floom-spin 0.9s linear infinite',
      }}
    >
      <path d="M12 3a9 9 0 019 9" />
    </svg>
  );
}
