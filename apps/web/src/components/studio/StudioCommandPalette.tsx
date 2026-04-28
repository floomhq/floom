import { useEffect } from 'react';
import type { CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';

interface Props {
  open: boolean;
  onClose: () => void;
}

const COMMANDS = [
  {
    id: 'new-app',
    label: 'New app',
    hint: 'Open the publish flow',
    to: '/studio/build',
  },
  {
    id: 'all-runs',
    label: 'All runs',
    hint: 'Latest activity across your apps',
    to: '/studio/runs',
  },
  {
    id: 'agent-tokens',
    label: 'Agent tokens',
    hint: 'Manage workspace credentials',
    to: '/settings/agent-tokens',
  },
  {
    id: 'settings',
    label: 'Studio settings',
    hint: 'Open Studio-local settings',
    to: '/settings/studio',
  },
];

export function StudioCommandPalette({ open, onClose }: Props) {
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      data-testid="studio-command-palette"
      style={backdropStyle}
      onClick={onClose}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        style={surfaceStyle}
      >
        <div style={headerStyle}>
          <div>
            <div style={eyebrowStyle}>Command palette</div>
            <h2 style={titleStyle}>Jump anywhere in Studio</h2>
          </div>
          <kbd style={kbdStyle}>Esc</kbd>
        </div>

        <div style={searchShellStyle}>
          <span style={searchIconStyle}>⌘K</span>
          <span style={searchTextStyle}>Search isn&rsquo;t wired yet. These shortcuts are live.</span>
        </div>

        <div style={commandsWrapStyle}>
          {COMMANDS.map((command) => (
            <button
              key={command.id}
              type="button"
              data-testid={`studio-command-${command.id}`}
              onClick={() => {
                navigate(command.to);
                onClose();
              }}
              style={commandStyle}
            >
              <div>
                <div style={commandLabelStyle}>{command.label}</div>
                <div style={commandHintStyle}>{command.hint}</div>
              </div>
              <span style={commandArrowStyle}>↗</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

const backdropStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 120,
  background: 'rgba(14,14,12,0.42)',
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'center',
  padding: '12vh 16px 24px',
};

const surfaceStyle: CSSProperties = {
  width: 'min(640px, 100%)',
  borderRadius: 20,
  background: 'var(--card)',
  border: '1px solid var(--line)',
  boxShadow: '0 20px 56px rgba(17,24,39,0.18)',
  overflow: 'hidden',
};

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 16,
  padding: '20px 22px 14px',
  borderBottom: '1px solid var(--line)',
};

const eyebrowStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color: 'var(--accent)',
};

const titleStyle: CSSProperties = {
  margin: '6px 0 0',
  fontFamily: 'var(--font-display)',
  fontSize: 26,
  fontWeight: 400,
  lineHeight: 1.1,
  letterSpacing: '-0.03em',
  color: 'var(--ink)',
};

const kbdStyle: CSSProperties = {
  padding: '5px 8px',
  borderRadius: 8,
  border: '1px solid var(--line)',
  background: 'var(--bg)',
  color: 'var(--muted)',
  fontFamily: 'JetBrains Mono, ui-monospace, monospace',
  fontSize: 11,
};

const searchShellStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  margin: '18px 22px 8px',
  padding: '12px 14px',
  borderRadius: 14,
  border: '1px solid var(--line)',
  background: 'var(--bg)',
};

const searchIconStyle: CSSProperties = {
  fontFamily: 'JetBrains Mono, ui-monospace, monospace',
  fontSize: 12,
  fontWeight: 700,
  color: 'var(--muted)',
};

const searchTextStyle: CSSProperties = {
  fontSize: 13,
  color: 'var(--muted)',
};

const commandsWrapStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '8px 12px 14px',
};

const commandStyle: CSSProperties = {
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 16,
  padding: '12px 12px 11px',
  border: '1px solid transparent',
  borderRadius: 14,
  background: 'transparent',
  cursor: 'pointer',
  fontFamily: 'inherit',
  textAlign: 'left',
};

const commandLabelStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 700,
  color: 'var(--ink)',
};

const commandHintStyle: CSSProperties = {
  marginTop: 3,
  fontSize: 12,
  color: 'var(--muted)',
  lineHeight: 1.5,
};

const commandArrowStyle: CSSProperties = {
  fontSize: 14,
  color: 'var(--muted)',
};
