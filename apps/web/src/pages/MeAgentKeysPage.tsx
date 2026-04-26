// /me/agent-keys — Agent tokens.
//
// v23 vocabulary lock: this page is "Agent tokens" everywhere
// user-visible. NOT "API keys" — the URL, headings, callouts, and
// labels all say "Agent tokens" / "agent token". Routes:
//
//   /me/agent-keys           canonical
//   /me/api-keys             redirect → /me/agent-keys
//   /me/settings/tokens      redirect → /me/agent-keys
//
// Wired to Better Auth's api-key plugin via the React `api.*` client.
// Backend rename `/auth/api-key/*` → `/api/me/agent-keys/*` is a v1.1
// follow-up (see keys-decision.md FLAG #6); the React layer keeps
// existing endpoint bindings.
//
// Display-once flow: when the user mints a token, the cleartext value
// only exists in this component's state for the lifetime of the open
// modal. Dismissing the modal forgets it; cancelling the modal calls
// the revoke endpoint so a half-leaked token never persists.

import { useEffect, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { MeLayout } from '../components/me/MeLayout';
import { MeTabStrip } from '../components/me/MeTabStrip';
import { useMyApps } from '../hooks/useMyApps';
import { useSecrets } from '../hooks/useSecrets';
import * as api from '../api/client';
import type { ApiKeyRecord, CreatedApiKey } from '../api/client';

// Time threshold for the ACTIVE pill on a token card. Any token used
// within the last 7 days renders the green ACTIVE pill; older usage is
// silent. Wireframe semantics, encoded once.
const ACTIVE_THRESHOLD_DAYS = 7;

const styles: Record<string, CSSProperties> = {
  head: { marginBottom: 20 },
  crumb: {
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 11.5,
    color: 'var(--muted)',
    marginBottom: 8,
  },
  crumbLink: {
    color: 'var(--muted)',
    textDecoration: 'none',
  },
  h1: {
    fontFamily: 'var(--font-display)',
    fontWeight: 800,
    fontSize: 38,
    letterSpacing: '-0.02em',
    lineHeight: 1.1,
    margin: '0 0 6px',
    color: 'var(--ink)',
  },
  subhead: {
    fontSize: 14,
    color: 'var(--muted)',
    margin: 0,
    lineHeight: 1.55,
    maxWidth: 580,
  },
  intro: {
    background: 'var(--accent-soft)',
    border: '1px solid var(--accent-border, #d1fae5)',
    borderRadius: 14,
    padding: '14px 18px',
    marginBottom: 18,
    display: 'flex',
    alignItems: 'flex-start',
    gap: 12,
  },
  introIcon: {
    width: 18,
    height: 18,
    color: 'var(--accent)',
    flexShrink: 0,
    marginTop: 2,
  },
  introText: {
    margin: 0,
    fontSize: 13,
    lineHeight: 1.55,
    color: 'var(--ink)',
  },
  actionsRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 14,
    gap: 12,
    flexWrap: 'wrap',
  },
  actionsTitle: {
    fontSize: 16,
    fontWeight: 600,
    margin: 0,
    color: 'var(--ink)',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
  },
  actionsCount: {
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 11,
    color: 'var(--muted)',
    fontWeight: 600,
  },
  newTokenBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '8px 14px',
    background: 'var(--accent)',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  card: {
    display: 'grid',
    gridTemplateColumns: 'auto minmax(0, 1fr) auto',
    gap: 16,
    alignItems: 'center',
    padding: '18px 20px',
    background: 'var(--card)',
    border: '1px solid var(--line)',
    borderRadius: 14,
    marginBottom: 10,
    boxShadow: '0 1px 0 rgba(17, 24, 39, 0.03)',
  },
  iconWrap: {
    width: 36,
    height: 36,
    borderRadius: 9,
    background: 'var(--accent-soft)',
    color: 'var(--accent)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    fontWeight: 700,
  },
  nameRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  cardName: {
    fontSize: 13.5,
    fontWeight: 600,
    color: 'var(--ink)',
  },
  scopePill: {
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 9.5,
    fontWeight: 700,
    letterSpacing: '0.04em',
    textTransform: 'uppercase' as const,
    padding: '2px 7px',
    borderRadius: 5,
  },
  scopeRw: {
    background: 'var(--accent)',
    color: '#fff',
  },
  scopeR: {
    background: 'var(--bg)',
    color: 'var(--muted)',
    border: '1px solid var(--line)',
  },
  activePill: {
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 9.5,
    fontWeight: 700,
    letterSpacing: '0.04em',
    textTransform: 'uppercase' as const,
    padding: '2px 7px',
    borderRadius: 5,
    background: 'var(--accent)',
    color: '#fff',
  },
  cardValue: {
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 11.5,
    color: 'var(--muted)',
    marginTop: 4,
  },
  metaRow: {
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 11,
    color: 'var(--muted)',
    marginTop: 6,
    display: 'flex',
    gap: 10,
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  metaStrong: {
    color: 'var(--ink)',
    fontWeight: 600,
  },
  actions: {
    display: 'flex',
    gap: 6,
    alignItems: 'center',
  },
  btnSecondary: {
    padding: '7px 12px',
    background: 'var(--card)',
    color: 'var(--ink)',
    border: '1px solid var(--line)',
    borderRadius: 8,
    fontSize: 12.5,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  btnGhostDanger: {
    padding: '7px 12px',
    background: 'transparent',
    color: 'var(--danger, #c44a2b)',
    border: '1px solid var(--line)',
    borderRadius: 8,
    fontSize: 12.5,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  emptyState: {
    border: '1px dashed var(--line)',
    borderRadius: 14,
    padding: '28px 22px',
    background: 'var(--card)',
    textAlign: 'center',
    color: 'var(--muted)',
    fontSize: 14,
    lineHeight: 1.5,
    marginBottom: 10,
  },
  errorBanner: {
    background: 'var(--danger-soft, #fdf1ec)',
    border: '1px solid var(--danger-border, #f0d5c9)',
    color: 'var(--danger, #c44a2b)',
    padding: '10px 14px',
    borderRadius: 8,
    fontSize: 13,
    marginBottom: 16,
  },
  // -------- Mint modal --------
  modalBackdrop: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(14, 14, 12, 0.45)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    zIndex: 100,
  },
  modal: {
    background: 'var(--card)',
    border: '1px solid var(--line)',
    borderRadius: 20,
    boxShadow: '0 24px 64px -24px rgba(14, 14, 12, 0.32)',
    width: '100%',
    maxWidth: 560,
    overflow: 'hidden',
  },
  modalHead: {
    padding: '18px 22px',
    borderBottom: '1px solid var(--line)',
  },
  modalTitle: {
    fontFamily: 'var(--font-display)',
    fontWeight: 800,
    fontSize: 20,
    letterSpacing: '-0.02em',
    margin: '0 0 4px',
    color: 'var(--ink)',
  },
  modalSub: {
    fontSize: 12.5,
    color: 'var(--muted)',
    margin: 0,
    lineHeight: 1.5,
  },
  modalBody: {
    padding: '18px 22px',
  },
  modalFoot: {
    padding: '14px 22px',
    background: 'var(--bg)',
    borderTop: '1px solid var(--line)',
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 8,
  },
  // Token block uses --code (warm dark), NEVER pure black per
  // feedback_terminal_never_black.md.
  tokenBlock: {
    background: 'var(--code, #1b1a17)',
    color: 'var(--code-text, #e8e6e0)',
    borderRadius: 10,
    padding: '14px 16px',
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 12,
    lineHeight: 1.6,
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    marginBottom: 12,
    overflow: 'hidden',
  },
  tokenValue: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  tokenCopyBtn: {
    background: 'var(--accent)',
    color: '#fff',
    border: 0,
    borderRadius: 6,
    padding: '5px 10px',
    fontSize: 10.5,
    fontWeight: 700,
    fontFamily: 'JetBrains Mono, monospace',
    letterSpacing: '0.04em',
    textTransform: 'uppercase' as const,
    cursor: 'pointer',
    flexShrink: 0,
  },
  warn: {
    background: 'var(--warning-soft, #fef3c7)',
    border: '1px solid #f5e0a8',
    borderRadius: 8,
    padding: '10px 12px',
    fontSize: 12,
    color: 'var(--warning, #c2791c)',
    lineHeight: 1.5,
    marginBottom: 14,
    display: 'flex',
    gap: 8,
    alignItems: 'flex-start',
  },
  snippetLab: {
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 10,
    color: 'var(--muted)',
    letterSpacing: '0.08em',
    textTransform: 'uppercase' as const,
    fontWeight: 600,
    margin: '14px 0 8px',
  },
  snippet: {
    background: 'var(--code, #1b1a17)',
    color: 'var(--code-text, #e8e6e0)',
    borderRadius: 8,
    padding: '12px 14px',
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 11.5,
    lineHeight: 1.55,
    overflow: 'auto',
    margin: 0,
    whiteSpace: 'pre' as const,
  },
  confirmRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginTop: 14,
    fontSize: 12.5,
    color: 'var(--muted)',
    cursor: 'pointer',
  },
  // -------- New-token name form (pre-modal) --------
  nameForm: {
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap',
    marginBottom: 18,
    padding: '14px 16px',
    border: '1px solid var(--line)',
    borderRadius: 10,
    background: 'var(--bg)',
  },
  nameInput: {
    flex: 1,
    minWidth: 220,
    padding: '9px 12px',
    border: '1px solid var(--line)',
    borderRadius: 8,
    fontSize: 13,
    background: 'var(--card)',
    color: 'var(--ink)',
    fontFamily: 'inherit',
  },
  btnAccent: {
    padding: '9px 16px',
    background: 'var(--accent)',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  btnAccentDisabled: {
    padding: '9px 16px',
    background: 'var(--accent)',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    cursor: 'not-allowed',
    fontFamily: 'inherit',
    opacity: 0.5,
  },
  formError: {
    fontSize: 12,
    color: 'var(--danger, #c44a2b)',
    width: '100%',
  },
};

// Pick a demo app for the cURL snippet — first installed app, falling
// back to a stable lead-scorer slug. Generic enough to be copy-pasteable.
function curlExample(token: string, demoSlug: string): string {
  return `curl -X POST https://floom.dev/api/p/${demoSlug}/run \\
  -H "Authorization: Bearer ${token}" \\
  -H "Content-Type: application/json" \\
  -d '{}'`;
}

function claudeSkillExample(token: string): string {
  return `claude skill add floom \\
  --token ${token}`;
}

export function MeAgentKeysPage() {
  const [keys, setKeys] = useState<ApiKeyRecord[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createState, setCreateState] = useState<'idle' | 'creating' | 'error'>(
    'idle',
  );
  const [createError, setCreateError] = useState('');
  // Cleartext token + parent record. Lives only while the modal is open;
  // Done/Cancel both clear it.
  const [justCreated, setJustCreated] = useState<CreatedApiKey | null>(null);
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const [revokeState, setRevokeState] = useState<'idle' | 'revoking'>('idle');

  // Sidebar context (for tab counts + cURL demo slug). Counts also wire
  // into the secrets tab pill via useSecrets.
  const { apps } = useMyApps();
  const { entries: secretsEntries } = useSecrets();

  async function loadKeys(): Promise<void> {
    try {
      const list = await api.listApiKeys();
      list.sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
      setKeys(list);
      setLoadError(null);
    } catch (err) {
      setKeys([]);
      setLoadError((err as Error).message || 'Failed to load agent tokens');
    }
  }

  useEffect(() => {
    void loadKeys();
  }, []);

  async function handleCreate(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const trimmed = createName.trim();
    if (!trimmed) return;
    setCreateState('creating');
    setCreateError('');
    try {
      const created = await api.createApiKey(trimmed);
      setJustCreated(created);
      setCreateName('');
      setShowCreate(false);
      setCreateState('idle');
      await loadKeys();
    } catch (err) {
      setCreateState('error');
      setCreateError((err as Error).message || 'Failed to create token');
    }
  }

  async function handleRevoke(keyId: string): Promise<void> {
    setRevokeState('revoking');
    try {
      await api.deleteApiKey(keyId);
      setRevokeId(null);
      setRevokeState('idle');
      await loadKeys();
    } catch (err) {
      setLoadError((err as Error).message || 'Failed to revoke token');
      setRevokeId(null);
      setRevokeState('idle');
    }
  }

  // Cancel-on-modal-dismiss: revokes the just-minted token so it can't
  // become a half-leaked secret. Wired to the modal's "Cancel" button.
  async function handleModalCancel(): Promise<void> {
    if (!justCreated) return;
    const id = justCreated.id;
    setJustCreated(null);
    try {
      await api.deleteApiKey(id);
      await loadKeys();
    } catch (err) {
      setLoadError(
        (err as Error).message || 'Failed to revoke just-minted token',
      );
    }
  }

  function handleModalDone(): void {
    setJustCreated(null);
  }

  const demoSlug = apps && apps.length > 0 ? apps[0].slug : 'lead-scorer';

  return (
    <MeLayout
      activeTab="agent-keys"
      title="Agent tokens · Floom"
      headerVariant="none"
      maxWidth={880}
    >
      <div data-testid="me-agent-keys-page">
        <div style={styles.head}>
          <div style={styles.crumb}>
            <Link to="/me" style={styles.crumbLink}>
              /me
            </Link>
            <span style={{ margin: '0 6px' }}>›</span>
            <span style={{ color: 'var(--ink)' }}>Agent tokens</span>
          </div>
          <h1 style={styles.h1}>Agent tokens</h1>
          <p style={styles.subhead}>
            Let Claude/Cursor/CLI act as you. One token works across MCP,
            REST, CLI.
          </p>
        </div>

        <MeTabStrip
          active="agent-keys"
          counts={{
            apps: apps?.length,
            secrets: secretsEntries?.length,
            agentKeys: (keys ?? []).length,
          }}
        />

        <div style={styles.intro}>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.75}
            style={styles.introIcon}
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M12 16v-4M12 8h.01" />
          </svg>
          <p style={styles.introText}>
            Tokens let agents (Claude Code, Cursor, Codex, Clawdbot, custom
            scripts) run any app on Floom on your behalf via the API. Tokens
            replace pasting your password into agent shells.
          </p>
        </div>

        {loadError && (
          <div
            data-testid="me-agent-keys-error"
            role="alert"
            style={styles.errorBanner}
          >
            {loadError}
          </div>
        )}

        <div style={styles.actionsRow}>
          <h2 style={styles.actionsTitle}>
            Active tokens
            {keys && keys.length > 0 ? (
              <span style={styles.actionsCount}>{keys.length}</span>
            ) : null}
          </h2>
          {!showCreate && (
            <button
              type="button"
              onClick={() => {
                setShowCreate(true);
                setCreateError('');
                setCreateState('idle');
              }}
              data-testid="tokens-create-trigger"
              style={styles.newTokenBtn}
            >
              <PlusIcon />
              New agent token
            </button>
          )}
        </div>

        {showCreate && (
          <form
            onSubmit={handleCreate}
            data-testid="tokens-create-form"
            style={styles.nameForm}
          >
            <input
              autoFocus
              data-testid="tokens-create-name"
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              placeholder="Name, e.g. 'laptop-cli' or 'github-actions'"
              maxLength={64}
              style={styles.nameInput}
            />
            <button
              type="submit"
              disabled={createState === 'creating' || !createName.trim()}
              data-testid="tokens-create-submit"
              style={
                createState !== 'creating' && createName.trim()
                  ? styles.btnAccent
                  : styles.btnAccentDisabled
              }
            >
              {createState === 'creating' ? 'Creating…' : 'Create'}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowCreate(false);
                setCreateName('');
                setCreateError('');
              }}
              style={styles.btnSecondary}
            >
              Cancel
            </button>
            {createError && (
              <div data-testid="tokens-create-error" style={styles.formError}>
                {createError}
              </div>
            )}
          </form>
        )}

        {keys === null ? (
          <div style={styles.emptyState}>Loading…</div>
        ) : keys.length === 0 ? (
          <div data-testid="tokens-empty" style={styles.emptyState}>
            No agent tokens yet. Mint one to use Floom from the CLI, the
            Claude Code skill, or any MCP client.
          </div>
        ) : (
          <div data-testid="tokens-list">
            {keys.map((k) => (
              <TokenCard
                key={k.id}
                record={k}
                isConfirming={revokeId === k.id}
                isRevoking={revokeId === k.id && revokeState === 'revoking'}
                onRevokeClick={() => setRevokeId(k.id)}
                onRevokeCancel={() => setRevokeId(null)}
                onRevokeConfirm={() => handleRevoke(k.id)}
              />
            ))}
          </div>
        )}
      </div>

      {justCreated && (
        <NewTokenModal
          created={justCreated}
          demoSlug={demoSlug}
          onCancel={handleModalCancel}
          onDone={handleModalDone}
        />
      )}
    </MeLayout>
  );
}

// -------- Token card --------

interface TokenCardProps {
  record: ApiKeyRecord;
  isConfirming: boolean;
  isRevoking: boolean;
  onRevokeClick: () => void;
  onRevokeCancel: () => void;
  onRevokeConfirm: () => void;
}

function TokenCard({
  record,
  isConfirming,
  isRevoking,
  onRevokeClick,
  onRevokeCancel,
  onRevokeConfirm,
}: TokenCardProps) {
  const label = record.name || '(unnamed)';
  // Mask: prefix only today (Better Auth `start` field). Once the
  // backend exposes last4 we switch to prefix…suffix.
  const preview = record.start
    ? `floom_agent_${record.start}…`
    : record.prefix || 'floom_agent_•••';
  const isActive = record.lastRequest
    ? daysSince(record.lastRequest) <= ACTIVE_THRESHOLD_DAYS
    : false;

  return (
    <div data-testid={`tokens-row-${record.id}`} style={styles.card}>
      <span aria-hidden style={styles.iconWrap}>
        <BadgeIcon />
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={styles.nameRow}>
          <span style={styles.cardName}>{label}</span>
          {/* Scope pill: V1 renders all existing tokens as read-write
              (Better Auth keys are unscoped today). When the backend
              adds a scope field, swap this to record.scope-driven. */}
          <span style={{ ...styles.scopePill, ...styles.scopeRw }}>
            read-write
          </span>
          {isActive && (
            <span
              style={styles.activePill}
              data-testid={`tokens-row-${record.id}-active`}
            >
              ACTIVE
            </span>
          )}
        </div>
        <div style={styles.cardValue}>{preview}</div>
        <div style={styles.metaRow}>
          <span>
            Created{' '}
            <strong style={styles.metaStrong}>
              {formatDate(record.createdAt)}
            </strong>
          </span>
          <span>·</span>
          <span>
            Last used{' '}
            <strong style={styles.metaStrong}>
              {record.lastRequest ? formatRelative(record.lastRequest) : '—'}
            </strong>
          </span>
        </div>
      </div>
      <div style={styles.actions}>
        {isConfirming ? (
          <>
            <button
              type="button"
              onClick={onRevokeCancel}
              disabled={isRevoking}
              data-testid={`tokens-revoke-cancel-${record.id}`}
              style={styles.btnSecondary}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onRevokeConfirm}
              disabled={isRevoking}
              data-testid={`tokens-revoke-confirm-${record.id}`}
              style={styles.btnGhostDanger}
            >
              {isRevoking ? 'Revoking…' : 'Confirm revoke'}
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={onRevokeClick}
            data-testid={`tokens-revoke-${record.id}`}
            style={styles.btnGhostDanger}
          >
            Revoke
          </button>
        )}
      </div>
    </div>
  );
}

// -------- New-token modal (display-once) --------

function NewTokenModal({
  created,
  demoSlug,
  onCancel,
  onDone,
}: {
  created: CreatedApiKey;
  demoSlug: string;
  onCancel: () => void;
  onDone: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(created.key);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API denied — user can still triple-click the value.
    }
  }

  // Esc dismissal triggers the same Cancel-revokes-token path
  // — never silently keep an uncopied secret around.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') void onCancel();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="agent-tokens-modal-title"
      style={styles.modalBackdrop}
      data-testid="agent-tokens-display-once-modal"
      onClick={onCancel}
    >
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalHead}>
          <h3 id="agent-tokens-modal-title" style={styles.modalTitle}>
            Your new agent token
          </h3>
          <p style={styles.modalSub}>
            This is the only time you&rsquo;ll see this token. Copy it now —
            we don&rsquo;t store it in plain text.
          </p>
        </div>
        <div style={styles.modalBody}>
          <div style={styles.tokenBlock}>
            <span
              style={styles.tokenValue}
              data-testid="agent-tokens-display-once-value"
            >
              {created.key}
            </span>
            <button
              type="button"
              onClick={copy}
              style={styles.tokenCopyBtn}
              data-testid="agent-tokens-display-once-copy"
            >
              {copied ? 'Copied' : 'Copy token'}
            </button>
          </div>
          <div style={styles.warn}>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.75}
              style={{ width: 14, height: 14, flexShrink: 0, marginTop: 2 }}
              aria-hidden="true"
            >
              <path d="M12 9v4M12 17h.01" />
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            </svg>
            <span>
              Treat this like a password. Anyone with this token can run apps
              on your behalf.
            </span>
          </div>

          <div style={styles.snippetLab}>cURL example</div>
          <pre style={styles.snippet}>{curlExample(created.key, demoSlug)}</pre>

          <div style={styles.snippetLab}>Add to Claude Code</div>
          <pre style={styles.snippet}>{claudeSkillExample(created.key)}</pre>

          <label style={styles.confirmRow}>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              data-testid="agent-tokens-display-once-confirm"
              style={{ margin: 0 }}
            />
            <span>I&rsquo;ve copied this token to a secure location.</span>
          </label>
        </div>
        <div style={styles.modalFoot}>
          <button
            type="button"
            onClick={onCancel}
            style={styles.btnSecondary}
            data-testid="agent-tokens-display-once-cancel"
          >
            Cancel (revoke this token)
          </button>
          <button
            type="button"
            onClick={onDone}
            disabled={!confirmed}
            style={confirmed ? styles.btnAccent : styles.btnAccentDisabled}
            data-testid="agent-tokens-display-once-done"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

// -------- Tiny helpers --------

function PlusIcon() {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="#fff"
      strokeWidth={2.2}
      aria-hidden="true"
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function BadgeIcon() {
  return (
    <svg
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}

function daysSince(iso: string): number {
  try {
    const d = new Date(iso).getTime();
    return (Date.now() - d) / 86_400_000;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function formatRelative(iso: string): string {
  try {
    const d = new Date(iso);
    const diff = Math.max(0, Date.now() - d.getTime());
    const min = Math.floor(diff / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.floor(hr / 24);
    if (day < 7) return `${day}d ago`;
    return d.toLocaleDateString();
  } catch {
    return iso;
  }
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toISOString().slice(0, 10);
  } catch {
    return iso;
  }
}
