/**
 * ShareModal — Notion-style share dialog for /p/:slug.
 *
 * Replaces the previous `navigator.share`/`clipboard.writeText` fallback on
 * the /p/:slug hero Share button. Layout mirrors the reference in #640:
 *
 *   [ App name          (visibility pill) ]
 *   [ email, email… ][ Can run v ][ Send invite ]
 *   ── People with access ───────────────────────
 *     row: email · status · last run · revoke
 *   ── Link sharing ─────────────────────────────
 *     toggle: Public link (subject to 1h review — see #637)
 *     row:    Private signed link  [copy]
 *   ── Visibility ───────────────────────────────
 *     radio: Private / Invite-only / Public
 *
 * Backend contract (stubbed for the initial PR — see #637 for real impl):
 *   POST /api/apps/:slug/invite  { emails: string[], permission }
 *     → { ok: true, invite_id: 'stub-<ts>' }
 *
 * Responsive: centered card on desktop, full-screen bottom-sheet on
 * viewports <= 640px. Accessible: role=dialog, aria-modal, aria-labelledby,
 * Escape closes, initial focus on the email input, simple focus trap
 * around the dialog surface.
 *
 * Design rules (MEMORY.md): real lucide SVGs — no emojis. Single
 * brand-green accent (#047857) for primary actions. Dark surface uses
 * --ink (#1b1a17), never pure black. No amber/red on state.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Mail, Link as LinkIcon, Users, Check, X, Trash2, Copy } from 'lucide-react';
import { inviteToApp, type InvitePermission } from '../../api/client';
import type { AppVisibility } from '../../lib/types';

export interface ShareModalProps {
  open: boolean;
  onClose: () => void;
  /** App slug, used for the invite POST and the share URL. */
  slug: string;
  /** Display name for the header. */
  appName: string;
  /** Current server-reported visibility. Drives the header pill + radio. */
  visibility?: AppVisibility;
  /**
   * URL the user just copied / is about to share. Built by the caller so
   * it can include the active `?run=…` when a run is selected, or the
   * tokenized /r/:id URL after shareRun() has flipped is_public.
   */
  shareUrl: string;
  /**
   * Optional: tokenized private signed URL distinct from shareUrl. If
   * absent we fall back to shareUrl for the "Private signed link" row.
   */
  privateSignedUrl?: string;
  /**
   * Seed for the People-with-access list. The backing endpoint is the
   * #637 work item; until it ships this is always `[]` and the list
   * renders an empty-state hint.
   */
  accessList?: AccessRow[];
  /**
   * Fired when the visibility radio changes. Caller wires this to the
   * existing creator-visibility PATCH (or ignores it on public pages).
   */
  onVisibilityChange?: (next: AppVisibility) => void;
}

export interface AccessRow {
  id: string;
  email: string;
  status: 'pending' | 'accepted';
  permission: InvitePermission;
  last_run_at?: string | null;
}

const VISIBILITY_OPTIONS: Array<{ value: AppVisibility; label: string; hint: string }> = [
  { value: 'private', label: 'Private', hint: 'Only you' },
  { value: 'invite-only', label: 'Invite-only', hint: 'People you add below' },
  { value: 'public', label: 'Public', hint: 'Anyone on Floom (reviewed in ~1h)' },
];

function visibilityPill(v: AppVisibility | undefined): { label: string; tone: 'neutral' | 'accent' } {
  switch (v) {
    case 'public':
      return { label: 'Public', tone: 'accent' };
    case 'invite-only':
    case 'auth-required':
      return { label: 'Invite-only', tone: 'neutral' };
    case 'unlisted':
      return { label: 'Unlisted', tone: 'neutral' };
    case 'private':
    default:
      return { label: 'Private', tone: 'neutral' };
  }
}

function parseEmails(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s));
}

function formatRelative(iso?: string | null): string {
  if (!iso) return '—';
  try {
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return '—';
    const diff = Math.max(0, Date.now() - t);
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  } catch {
    return '—';
  }
}

export function ShareModal({
  open,
  onClose,
  slug,
  appName,
  visibility,
  shareUrl,
  privateSignedUrl,
  accessList,
  onVisibilityChange,
}: ShareModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const emailInputRef = useRef<HTMLInputElement>(null);
  const [emailInput, setEmailInput] = useState('');
  const [chips, setChips] = useState<string[]>([]);
  const [permission, setPermission] = useState<InvitePermission>('run');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [inviteOk, setInviteOk] = useState(false);
  const [copied, setCopied] = useState<'public' | 'private' | null>(null);
  const [publicToggle, setPublicToggle] = useState<boolean>(visibility === 'public');
  const [rows, setRows] = useState<AccessRow[]>(accessList ?? []);

  // Sync seed when caller reloads access list.
  useEffect(() => {
    setRows(accessList ?? []);
  }, [accessList]);

  // Sync the public-toggle with the authoritative visibility prop so a
  // creator flipping the radio upstream keeps the toggle state honest.
  useEffect(() => {
    setPublicToggle(visibility === 'public');
  }, [visibility]);

  // Close on Escape; capture focus inside the dialog.
  useEffect(() => {
    if (!open) return;
    const prevActive = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'Tab' && dialogRef.current) {
        const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    // Seed focus after the paint so the input is available.
    const tid = window.setTimeout(() => emailInputRef.current?.focus(), 0);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.clearTimeout(tid);
      prevActive?.focus?.();
    };
  }, [open, onClose]);

  const pushChipsFromInput = useCallback(() => {
    const parsed = parseEmails(emailInput);
    if (parsed.length === 0) return;
    setChips((prev) => {
      const next = [...prev];
      for (const e of parsed) {
        if (!next.includes(e)) next.push(e);
      }
      return next;
    });
    setEmailInput('');
  }, [emailInput]);

  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        pushChipsFromInput();
      } else if (e.key === 'Backspace' && emailInput === '' && chips.length > 0) {
        setChips((prev) => prev.slice(0, -1));
      }
    },
    [emailInput, chips.length, pushChipsFromInput],
  );

  const removeChip = useCallback((email: string) => {
    setChips((prev) => prev.filter((e) => e !== email));
  }, []);

  const handleSendInvite = useCallback(async () => {
    // Flush any still-typed email into chips before sending.
    const trailing = parseEmails(emailInput);
    const all = Array.from(new Set([...chips, ...trailing]));
    if (all.length === 0) {
      setSendError('Add at least one email.');
      return;
    }
    setSending(true);
    setSendError(null);
    setInviteOk(false);
    try {
      await inviteToApp(slug, { emails: all, permission });
      setInviteOk(true);
      // Optimistic row add — real list will reconcile once #637 ships the
      // GET endpoint. Status stays 'pending' until the invitee accepts.
      setRows((prev) => {
        const byEmail = new Map(prev.map((r) => [r.email, r] as const));
        for (const email of all) {
          if (!byEmail.has(email)) {
            byEmail.set(email, {
              id: `pending-${email}`,
              email,
              status: 'pending',
              permission,
              last_run_at: null,
            });
          }
        }
        return Array.from(byEmail.values());
      });
      setChips([]);
      setEmailInput('');
      window.setTimeout(() => setInviteOk(false), 2000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not send invite.';
      setSendError(msg);
    } finally {
      setSending(false);
    }
  }, [chips, emailInput, permission, slug]);

  const handleCopy = useCallback((url: string, which: 'public' | 'private') => {
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(which);
      window.setTimeout(() => setCopied(null), 1400);
    });
  }, []);

  const handleRevoke = useCallback((id: string) => {
    // Stub: real endpoint tracked in #637. Remove optimistically so the
    // modal feels responsive even before the DELETE route lands.
    setRows((prev) => prev.filter((r) => r.id !== id));
  }, []);

  const pill = useMemo(() => visibilityPill(visibility), [visibility]);
  const privateLink = privateSignedUrl || shareUrl;

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="share-modal-title"
      data-testid="share-modal"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1100,
        background: 'rgba(27, 26, 23, 0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
        className="share-modal-surface"
        style={{
          background: 'var(--card, #ffffff)',
          color: 'var(--ink, #1b1a17)',
          border: '1px solid var(--line, rgba(27,26,23,0.12))',
          borderRadius: 16,
          width: '100%',
          maxWidth: 520,
          maxHeight: 'calc(100vh - 32px)',
          overflow: 'auto',
          boxShadow: '0 20px 60px rgba(27,26,23,0.25)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* ───────── Header ───────── */}
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            padding: '18px 20px 14px',
            borderBottom: '1px solid var(--line, rgba(27,26,23,0.1))',
          }}
        >
          <div style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
            <h2
              id="share-modal-title"
              style={{ fontSize: 15.5, fontWeight: 600, margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
            >
              Share {appName}
            </h2>
            <span
              data-testid="share-modal-visibility-pill"
              style={{
                fontSize: 11,
                fontWeight: 600,
                padding: '3px 8px',
                borderRadius: 999,
                background: pill.tone === 'accent' ? 'var(--accent, #047857)' : 'rgba(27,26,23,0.06)',
                color: pill.tone === 'accent' ? '#ffffff' : 'var(--ink, #1b1a17)',
                border: pill.tone === 'accent' ? 'none' : '1px solid var(--line, rgba(27,26,23,0.12))',
                letterSpacing: 0.2,
                textTransform: 'uppercase',
              }}
            >
              {pill.label}
            </span>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            style={{
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              padding: 6,
              borderRadius: 8,
              color: 'var(--ink, #1b1a17)',
              display: 'inline-flex',
            }}
          >
            <X size={18} />
          </button>
        </header>

        {/* ───────── Invite by email ───────── */}
        <section style={{ padding: '16px 20px 12px' }}>
          <div
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'stretch',
              flexWrap: 'wrap',
            }}
          >
            <div
              style={{
                flex: '1 1 260px',
                minWidth: 0,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                flexWrap: 'wrap',
                border: '1px solid var(--line, rgba(27,26,23,0.16))',
                borderRadius: 10,
                padding: '6px 10px',
                background: 'var(--card, #ffffff)',
              }}
            >
              <Mail size={14} aria-hidden="true" style={{ color: 'var(--muted, #6c6a66)', flexShrink: 0 }} />
              {chips.map((email) => (
                <span
                  key={email}
                  data-testid="share-modal-chip"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    fontSize: 12.5,
                    padding: '2px 4px 2px 8px',
                    borderRadius: 999,
                    background: 'rgba(4,120,87,0.08)',
                    color: 'var(--accent, #047857)',
                    border: '1px solid rgba(4,120,87,0.2)',
                  }}
                >
                  {email}
                  <button
                    type="button"
                    aria-label={`Remove ${email}`}
                    onClick={() => removeChip(email)}
                    style={{
                      border: 'none',
                      background: 'transparent',
                      cursor: 'pointer',
                      padding: 2,
                      display: 'inline-flex',
                      color: 'inherit',
                    }}
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
              <input
                ref={emailInputRef}
                type="email"
                value={emailInput}
                onChange={(e) => setEmailInput(e.target.value)}
                onKeyDown={handleInputKeyDown}
                onBlur={pushChipsFromInput}
                placeholder={chips.length === 0 ? 'Email, comma or Enter to add' : ''}
                aria-label="Invitee emails"
                data-testid="share-modal-email-input"
                style={{
                  flex: '1 1 140px',
                  minWidth: 100,
                  border: 'none',
                  outline: 'none',
                  background: 'transparent',
                  fontSize: 13,
                  padding: '6px 0',
                  color: 'var(--ink, #1b1a17)',
                  fontFamily: 'inherit',
                }}
              />
            </div>
            <select
              aria-label="Permission"
              data-testid="share-modal-permission"
              value={permission}
              onChange={(e) => setPermission(e.target.value as InvitePermission)}
              style={{
                fontSize: 12.5,
                padding: '8px 10px',
                borderRadius: 10,
                border: '1px solid var(--line, rgba(27,26,23,0.16))',
                background: 'var(--card, #ffffff)',
                color: 'var(--ink, #1b1a17)',
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              <option value="run">Can run</option>
              <option value="view">Can view</option>
            </select>
            <button
              type="button"
              onClick={handleSendInvite}
              disabled={sending}
              data-testid="share-modal-send-invite"
              style={{
                fontSize: 13,
                fontWeight: 600,
                padding: '8px 14px',
                borderRadius: 10,
                border: '1px solid var(--accent, #047857)',
                background: 'var(--accent, #047857)',
                color: '#ffffff',
                cursor: sending ? 'progress' : 'pointer',
                fontFamily: 'inherit',
                opacity: sending ? 0.7 : 1,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              {inviteOk ? <Check size={14} aria-hidden="true" /> : null}
              {inviteOk ? 'Invited' : sending ? 'Sending…' : 'Send invite'}
            </button>
          </div>
          {sendError && (
            <p
              role="alert"
              data-testid="share-modal-error"
              style={{ fontSize: 12, color: 'var(--ink, #1b1a17)', marginTop: 8, marginBottom: 0 }}
            >
              {sendError}
            </p>
          )}
        </section>

        {/* ───────── People with access ───────── */}
        <section style={{ padding: '4px 20px 16px' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 11.5,
              fontWeight: 600,
              color: 'var(--muted, #6c6a66)',
              letterSpacing: 0.4,
              textTransform: 'uppercase',
              margin: '4px 0 8px',
            }}
          >
            <Users size={12} aria-hidden="true" /> People with access
          </div>
          {rows.length === 0 ? (
            <p style={{ fontSize: 12.5, color: 'var(--muted, #6c6a66)', margin: 0 }}>
              Only you, for now. Invite teammates above.
            </p>
          ) : (
            <ul
              data-testid="share-modal-access-list"
              style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 4 }}
            >
              {rows.map((row) => (
                <li
                  key={row.id}
                  data-testid="share-modal-access-row"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '8px 10px',
                    borderRadius: 8,
                    border: '1px solid var(--line, rgba(27,26,23,0.08))',
                    background: 'var(--card, #ffffff)',
                  }}
                >
                  <span style={{ flex: 1, minWidth: 0, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {row.email}
                  </span>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      padding: '2px 8px',
                      borderRadius: 999,
                      background: row.status === 'accepted' ? 'rgba(4,120,87,0.1)' : 'rgba(27,26,23,0.06)',
                      color: row.status === 'accepted' ? 'var(--accent, #047857)' : 'var(--muted, #6c6a66)',
                    }}
                  >
                    {row.status === 'accepted' ? 'Accepted' : 'Pending'}
                  </span>
                  <span style={{ fontSize: 11.5, color: 'var(--muted, #6c6a66)', minWidth: 68, textAlign: 'right' }}>
                    {formatRelative(row.last_run_at)}
                  </span>
                  <button
                    type="button"
                    aria-label={`Revoke ${row.email}`}
                    onClick={() => handleRevoke(row.id)}
                    style={{
                      border: 'none',
                      background: 'transparent',
                      cursor: 'pointer',
                      padding: 4,
                      borderRadius: 6,
                      display: 'inline-flex',
                      color: 'var(--muted, #6c6a66)',
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ───────── Link sharing ───────── */}
        <section
          style={{
            padding: '12px 20px 16px',
            borderTop: '1px solid var(--line, rgba(27,26,23,0.08))',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 11.5,
              fontWeight: 600,
              color: 'var(--muted, #6c6a66)',
              letterSpacing: 0.4,
              textTransform: 'uppercase',
              margin: '0 0 10px',
            }}
          >
            <LinkIcon size={12} aria-hidden="true" /> Link sharing
          </div>

          {/* Public toggle */}
          <label
            data-testid="share-modal-public-toggle"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '8px 0',
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={publicToggle}
              onChange={(e) => {
                const next = e.target.checked;
                setPublicToggle(next);
                onVisibilityChange?.(next ? 'public' : 'invite-only');
              }}
              style={{ accentColor: 'var(--accent, #047857)' }}
            />
            <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontSize: 13, fontWeight: 500 }}>Public link</span>
              <span style={{ fontSize: 11.5, color: 'var(--muted, #6c6a66)' }}>
                Subject to a ~1h review before it appears in the Floom store (tracked in #637).
              </span>
            </span>
          </label>

          {/* Private signed link */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 12px',
              border: '1px solid var(--line, rgba(27,26,23,0.12))',
              borderRadius: 10,
              background: 'var(--card, #ffffff)',
              marginTop: 8,
            }}
          >
            <LinkIcon size={14} aria-hidden="true" style={{ color: 'var(--muted, #6c6a66)', flexShrink: 0 }} />
            <input
              readOnly
              value={privateLink}
              aria-label="Private signed link"
              data-testid="share-modal-private-url"
              onFocus={(e) => e.currentTarget.select()}
              style={{
                flex: 1,
                minWidth: 0,
                border: 'none',
                outline: 'none',
                background: 'transparent',
                fontSize: 12.5,
                fontFamily:
                  'ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace',
                color: 'var(--ink, #1b1a17)',
                padding: 0,
              }}
            />
            <button
              type="button"
              onClick={() => handleCopy(privateLink, 'private')}
              data-testid="share-modal-copy-private"
              aria-label="Copy private link"
              style={{
                border: '1px solid var(--line, rgba(27,26,23,0.16))',
                background: 'var(--card, #ffffff)',
                color: 'var(--ink, #1b1a17)',
                cursor: 'pointer',
                fontSize: 12,
                fontWeight: 600,
                padding: '6px 10px',
                borderRadius: 8,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                fontFamily: 'inherit',
              }}
            >
              {copied === 'private' ? <Check size={12} /> : <Copy size={12} />}
              {copied === 'private' ? 'Copied' : 'Copy'}
            </button>
          </div>

          <p style={{ fontSize: 11.5, color: 'var(--muted, #6c6a66)', margin: '8px 0 0' }}>
            Signed links stay active until you revoke them, even while the app is private.
          </p>
        </section>

        {/* ───────── Visibility radio ───────── */}
        <section
          style={{
            padding: '12px 20px 20px',
            borderTop: '1px solid var(--line, rgba(27,26,23,0.08))',
          }}
        >
          <div
            style={{
              fontSize: 11.5,
              fontWeight: 600,
              color: 'var(--muted, #6c6a66)',
              letterSpacing: 0.4,
              textTransform: 'uppercase',
              margin: '0 0 10px',
            }}
          >
            Visibility
          </div>
          <div
            role="radiogroup"
            aria-label="App visibility"
            data-testid="share-modal-visibility-radio"
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}
          >
            {VISIBILITY_OPTIONS.map((opt) => {
              const active = (visibility ?? 'private') === opt.value;
              return (
                <label
                  key={opt.value}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '8px 10px',
                    borderRadius: 10,
                    border: active
                      ? '1px solid var(--accent, #047857)'
                      : '1px solid var(--line, rgba(27,26,23,0.12))',
                    background: active ? 'rgba(4,120,87,0.06)' : 'var(--card, #ffffff)',
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="radio"
                    name="share-modal-visibility"
                    value={opt.value}
                    checked={active}
                    onChange={() => onVisibilityChange?.(opt.value)}
                    style={{ accentColor: 'var(--accent, #047857)' }}
                  />
                  <span style={{ display: 'flex', flexDirection: 'column' }}>
                    <span style={{ fontSize: 13, fontWeight: 500 }}>{opt.label}</span>
                    <span style={{ fontSize: 11.5, color: 'var(--muted, #6c6a66)' }}>{opt.hint}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </section>
      </div>

      {/* Responsive polish: full-screen bottom-sheet on mobile. */}
      <style>{`
        @media (max-width: 640px) {
          [data-testid="share-modal"] {
            align-items: flex-end !important;
            padding: 0 !important;
          }
          [data-testid="share-modal"] .share-modal-surface {
            max-width: 100% !important;
            width: 100% !important;
            max-height: 92vh !important;
            border-radius: 18px 18px 0 0 !important;
          }
        }
      `}</style>
    </div>
  );
}

export default ShareModal;
