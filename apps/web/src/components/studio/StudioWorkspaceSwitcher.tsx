import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import * as api from '../../api/client';
import { refreshMyApps } from '../../hooks/useMyApps';
import { refreshSession } from '../../hooks/useSession';
import type { SessionWorkspace } from '../../lib/types';

interface Props {
  active: SessionWorkspace;
  workspaces: SessionWorkspace[];
  viewerName?: string | null;
}

export function StudioWorkspaceSwitcher({
  active,
  workspaces,
  viewerName,
}: Props) {
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setCreating(false);
        setError(null);
      }
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
        setCreating(false);
        setError(null);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    if (creating && inputRef.current) {
      inputRef.current.focus();
    }
  }, [creating]);

  async function syncWorkspaceState() {
    await refreshSession();
    await refreshMyApps();
  }

  async function handleSelect(workspaceId: string) {
    if (switching || workspaceId === active.id) {
      setOpen(false);
      setCreating(false);
      return;
    }
    setSwitching(workspaceId);
    setError(null);
    try {
      await api.switchWorkspace(workspaceId);
      await syncWorkspaceState();
      setOpen(false);
      setCreating(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not switch workspace');
    } finally {
      setSwitching(null);
    }
  }

  async function handleCreate() {
    const name = newName.trim();
    if (!name || switching) return;
    setSwitching('new');
    setError(null);
    try {
      await api.createWorkspace({ name });
      await syncWorkspaceState();
      setNewName('');
      setOpen(false);
      setCreating(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create workspace');
    } finally {
      setSwitching(null);
    }
  }

  const label = workspaceDisplayName(active, viewerName);
  const roleLabel = workspaceRoleLabel(active.role);

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button
        type="button"
        data-testid="studio-workspace-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
          setCreating(false);
          setError(null);
        }}
        disabled={switching !== null}
        style={triggerStyle(switching !== null)}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={triggerTitleStyle}>{label}</div>
          <div style={triggerMetaStyle}>{roleLabel}</div>
        </div>
        {switching ? <Spinner size={12} /> : <ChevronIcon size={12} open={open} />}
      </button>

      {open && (
        <div
          role="menu"
          data-testid="studio-workspace-menu"
          style={menuStyle}
        >
          {workspaces.map((workspace) => {
            const isActive = workspace.id === active.id;
            const isBusy = switching !== null;
            return (
              <button
                key={workspace.id}
                type="button"
                role="menuitem"
                data-testid={`studio-workspace-option-${workspace.slug}`}
                onClick={() => handleSelect(workspace.id)}
                disabled={isBusy}
                style={optionStyle(isActive, isBusy)}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={optionTitleStyle}>{workspaceDisplayName(workspace, viewerName)}</div>
                  <div style={optionMetaStyle}>{workspaceRoleLabel(workspace.role)}</div>
                </div>
                {isActive ? <CheckIcon size={12} /> : null}
              </button>
            );
          })}

          <div style={dividerStyle} />

          {!creating ? (
            <button
              type="button"
              role="menuitem"
              data-testid="studio-workspace-new"
              onClick={() => {
                setCreating(true);
                setError(null);
              }}
              disabled={switching !== null}
              style={newWorkspaceButtonStyle}
            >
              <PlusIcon size={12} />
              <span>New workspace</span>
            </button>
          ) : (
            <div style={createWrapStyle}>
              <label htmlFor="studio-workspace-new-name" style={createLabelStyle}>
                New workspace
              </label>
              <input
                ref={inputRef}
                id="studio-workspace-new-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void handleCreate();
                  }
                }}
                placeholder="Workspace name"
                data-testid="studio-workspace-new-input"
                style={createInputStyle}
              />
              <div style={createActionsStyle}>
                <button
                  type="button"
                  onClick={() => {
                    setCreating(false);
                    setNewName('');
                    setError(null);
                  }}
                  style={secondaryActionStyle}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void handleCreate();
                  }}
                  disabled={!newName.trim() || switching !== null}
                  style={primaryActionStyle(!newName.trim() || switching !== null)}
                >
                  Create
                </button>
              </div>
            </div>
          )}

          {error ? (
            <div
              role="alert"
              data-testid="studio-workspace-error"
              style={errorStyle}
            >
              {error}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function workspaceDisplayName(
  workspace: SessionWorkspace,
  viewerName?: string | null,
): string {
  if (viewerName) {
    const first = viewerName.trim().split(/\s+/)[0];
    const normalized = workspace.name.trim().toLowerCase();
    const personalName = `${viewerName.toLowerCase()}'s workspace`;
    if (normalized === personalName) {
      return `${first} · personal`;
    }
  }
  return workspace.name;
}

function workspaceRoleLabel(role: string): string {
  if (role === 'admin') return 'Owner';
  if (role === 'editor') return 'Editor';
  if (role === 'viewer') return 'Viewer';
  return 'Guest';
}

function triggerStyle(disabled: boolean): CSSProperties {
  return {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '12px 12px 11px',
    borderRadius: 14,
    border: '1px solid var(--line)',
    background: 'var(--card)',
    color: 'var(--ink)',
    cursor: disabled ? 'wait' : 'pointer',
    fontFamily: 'inherit',
    textAlign: 'left',
    opacity: disabled ? 0.72 : 1,
    boxShadow: '0 1px 0 rgba(17,24,39,0.02)',
  };
}

const triggerTitleStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  lineHeight: 1.3,
  color: 'var(--ink)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const triggerMetaStyle: CSSProperties = {
  fontSize: 11,
  lineHeight: 1.4,
  color: 'var(--muted)',
};

const menuStyle: CSSProperties = {
  position: 'absolute',
  top: 'calc(100% + 8px)',
  left: 0,
  right: 0,
  zIndex: 60,
  padding: 6,
  background: 'var(--card)',
  border: '1px solid var(--line)',
  borderRadius: 14,
  boxShadow: '0 18px 40px rgba(17,24,39,0.12)',
};

function optionStyle(isActive: boolean, disabled: boolean): CSSProperties {
  return {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 10px 9px',
    border: 'none',
    borderRadius: 10,
    background: isActive ? 'var(--accent-soft)' : 'transparent',
    color: isActive ? 'var(--accent)' : 'var(--ink)',
    cursor: disabled ? 'wait' : 'pointer',
    fontFamily: 'inherit',
    textAlign: 'left',
  };
}

const optionTitleStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  lineHeight: 1.35,
  color: 'inherit',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const optionMetaStyle: CSSProperties = {
  fontSize: 11,
  lineHeight: 1.4,
  color: 'var(--muted)',
};

const dividerStyle: CSSProperties = {
  height: 1,
  background: 'var(--line)',
  margin: '6px 4px',
};

const newWorkspaceButtonStyle: CSSProperties = {
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '10px 10px 9px',
  border: 'none',
  borderRadius: 10,
  background: 'transparent',
  color: 'var(--ink)',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 13,
  fontWeight: 600,
  textAlign: 'left',
};

const createWrapStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: '8px 8px 4px',
};

const createLabelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--muted)',
};

const createInputStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '9px 11px',
  borderRadius: 10,
  border: '1px solid var(--line)',
  background: 'var(--bg)',
  color: 'var(--ink)',
  fontSize: 13,
  fontFamily: 'inherit',
};

const createActionsStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 8,
};

const secondaryActionStyle: CSSProperties = {
  padding: '8px 12px',
  borderRadius: 999,
  border: '1px solid var(--line)',
  background: 'transparent',
  color: 'var(--muted)',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

function primaryActionStyle(disabled: boolean): CSSProperties {
  return {
    padding: '8px 12px',
    borderRadius: 999,
    border: 'none',
    background: 'var(--ink)',
    color: '#fff',
    fontSize: 12,
    fontWeight: 700,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.55 : 1,
    fontFamily: 'inherit',
  };
}

const errorStyle: CSSProperties = {
  margin: '6px 8px 4px',
  padding: '8px 10px',
  borderRadius: 10,
  background: '#fef2f2',
  color: '#b42318',
  fontSize: 12,
  lineHeight: 1.5,
};

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

function PlusIcon({ size = 12 }: { size?: number }) {
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
      style={{ flexShrink: 0 }}
    >
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

function Spinner({ size = 12 }: { size?: number }) {
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
      <path d="M12 3a9 9 0 1 0 9 9" />
    </svg>
  );
}
