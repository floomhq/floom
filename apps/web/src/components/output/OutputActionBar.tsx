// OutputActionBar — R7.7 (2026-04-28): sticky master action row for the
// composite output card on /p/:slug.
//
// Federico's brief (R7.7):
//   - Master sticky toolbar lifts the "Done · App · 995ms" badge inline
//     and exposes Copy JSON, Download all CSVs, Expand-all (icon buttons).
//   - Per-section action icons (Copy, Download CSV, Expand) live at the
//     right end of each SectionHeader — visible by default in composite
//     mode, NOT hidden by CSS. Tooltips over icons.
//   - Master Expand opens the entire output in a viewport modal (Esc).
//   - Per-section Expand opens THAT specific section in a viewport modal.
//
// Keep this component dumb — it renders the sticky strip and the icon
// buttons. The download-all / per-section copy / fullscreen wiring lives
// in renderer callsites.
import React, { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

// Re-export so unused-locals tsconfig stays happy when iconBtnStyle is
// the only place we touch the React namespace (some shared-config
// projects forbid React-as-default-import otherwise).
void React;

interface ActionBarProps {
  label?: string;
  /**
   * Optional Done-badge (the green check + "App · 995ms" text). When
   * provided it renders to the LEFT of the label, replacing the inert
   * "OUTPUT" eyebrow with run-state context. R7.7: lifted from the
   * separate run-header row above the card so the toolbar carries the
   * full success signal.
   */
  doneBadge?: ReactNode;
  /** Right-aligned action buttons. Render with <button> for accessibility. */
  actions: ReactNode;
}

export function OutputActionBar({ label = 'Output', doneBadge, actions }: ActionBarProps) {
  return (
    <div
      className="floom-output-action-bar"
      data-testid="output-action-bar"
      style={{
        // R7.5: sticky-to-top so the toolbar stays visible while the
        // output body scrolls. `top: 0` is relative to the nearest
        // scroll-container ancestor (typically the page; the composite
        // card uses overflow:hidden, so sticky resolves against the
        // surrounding /p/:slug page).
        position: 'sticky',
        top: 0,
        zIndex: 5,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '10px 14px',
        // R7.7: tinted bar so the sticky strip reads as a toolbar, not
        // just a slightly-bordered slice of the body.
        background: 'var(--studio, #f5f4f0)',
        borderBottom: '1px solid var(--line)',
        boxShadow: '0 1px 0 var(--line)',
        flexWrap: 'wrap',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flexWrap: 'wrap' }}>
        {doneBadge ?? (
          <>
            <span
              aria-hidden="true"
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: 'var(--accent, #047857)',
                flexShrink: 0,
              }}
            />
            <span
              style={{
                fontSize: 11,
                color: 'var(--muted)',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                fontWeight: 600,
                fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
              }}
            >
              {label}
            </span>
          </>
        )}
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          flexShrink: 0,
          flexWrap: 'wrap',
        }}
      >
        {actions}
      </div>
    </div>
  );
}

/**
 * Done badge rendered inside the master sticky toolbar. Replaces the
 * older standalone run-header above the card so the success signal is
 * pinned to the toolbar while the output body scrolls.
 */
export function OutputDoneBadge({
  appName,
  durationLabel,
}: {
  appName: string;
  durationLabel: string;
}) {
  return (
    <span
      data-testid="output-action-bar-done"
      aria-label={`Done. ${appName}. ${durationLabel}.`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 12,
        color: 'var(--ink)',
        fontWeight: 600,
      }}
    >
      <svg
        viewBox="0 0 16 16"
        width={14}
        height={14}
        aria-hidden="true"
        style={{ flexShrink: 0, color: 'var(--accent, #047857)' }}
      >
        <circle cx="8" cy="8" r="7" fill="currentColor" opacity="0.15" />
        <path
          d="M4.5 8.3l2.3 2.3 4.7-5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span style={{ color: 'var(--accent, #047857)' }}>Done</span>
      <span style={{ color: 'var(--muted)', fontWeight: 500 }}>·</span>
      <span style={{ color: 'var(--ink)' }}>{appName}</span>
      <span style={{ color: 'var(--muted)', fontWeight: 500 }}>·</span>
      <span style={{ color: 'var(--muted)', fontWeight: 500 }}>{durationLabel}</span>
    </span>
  );
}

interface FullscreenModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
}

/**
 * Fullscreen modal for per-table expand. Renders into document.body via
 * portal so it escapes any clipped/overflow:hidden ancestor. Closes on
 * Escape and on backdrop click.
 */
export function TableFullscreenModal({ open, onClose, title, children }: FullscreenModalProps) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    // Lock background scroll while open.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open || typeof document === 'undefined') return null;

  const modal = (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title ?? 'Expanded view'}
      data-testid="output-fullscreen-modal"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15, 14, 12, 0.55)',
        zIndex: 200,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        style={{
          background: 'var(--card)',
          border: '1px solid var(--line)',
          borderRadius: 14,
          width: 'min(1200px, calc(100vw - 48px))',
          maxHeight: 'calc(100vh - 48px)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: '0 24px 64px rgba(0,0,0,0.32)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '14px 18px',
            borderBottom: '1px solid var(--line)',
            background: 'var(--card)',
            flexShrink: 0,
          }}
        >
          <span
            style={{
              fontSize: 11,
              color: 'var(--muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              fontWeight: 600,
              fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
            }}
          >
            {title ?? 'Expanded view'}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close fullscreen view"
            style={{
              background: 'transparent',
              border: '1px solid var(--line)',
              color: 'var(--muted)',
              padding: '4px 12px',
              fontSize: 12,
              fontWeight: 600,
              fontFamily: 'inherit',
              borderRadius: 6,
              cursor: 'pointer',
            }}
          >
            Close · Esc
          </button>
        </div>
        <div
          style={{
            overflow: 'auto',
            padding: '20px 22px',
            flex: 1,
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}

/** Shared icon-button base. Square 28x28, neutral chrome, hover accent. */
function iconBtnStyle(): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 28,
    height: 28,
    background: 'var(--card)',
    border: '1px solid var(--line)',
    borderRadius: 6,
    color: 'var(--muted)',
    cursor: 'pointer',
    padding: 0,
    transition: 'border-color 0.15s, color 0.15s',
  };
}

interface FullscreenButtonProps {
  onClick: () => void;
  label?: string;
}

/** Small icon-button to expand a table into the fullscreen modal. */
export function FullscreenButton({ onClick, label = 'Expand to fullscreen' }: FullscreenButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      data-testid="output-fullscreen-btn"
      className="output-icon-btn"
      style={iconBtnStyle()}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <polyline points="15 3 21 3 21 9" />
        <polyline points="9 21 3 21 3 15" />
        <line x1="21" y1="3" x2="14" y2="10" />
        <line x1="3" y1="21" x2="10" y2="14" />
      </svg>
    </button>
  );
}

/**
 * R7.7 — clipboard icon button for "Copy section JSON". Uses two-overlapping-
 * squares glyph. Click writes `value` to navigator.clipboard and shows a
 * brief "Copied" tooltip.
 */
export function IconCopyButton({
  value,
  label = 'Copy JSON',
}: {
  value: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard blocked; noop */
    }
  };
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
      data-testid="output-icon-copy-btn"
      className="output-icon-btn"
      style={iconBtnStyle()}
    >
      {copied ? (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          style={{ color: 'var(--accent, #047857)' }}
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  );
}

/**
 * R7.7 — download icon button. Click invokes `onClick` (caller assembles
 * the CSV + Blob + anchor download). Tooltip says "Download CSV" by
 * default; callers can override via `label`.
 */
export function IconDownloadButton({
  onClick,
  label = 'Download CSV',
  disabled = false,
}: {
  onClick: () => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      disabled={disabled}
      data-testid="output-icon-download-btn"
      className="output-icon-btn"
      style={{
        ...iconBtnStyle(),
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
    </button>
  );
}
