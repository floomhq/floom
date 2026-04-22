// Personal API keys — canonical at /me/api-keys (aliased at /me/settings/tokens
// for back-compat, 2026-04-23 IA shift).
//
// Moved out of the Studio-nested Settings tab because API keys are
// account-scoped: users need them both for building (Studio) AND running
// apps from the CLI / Claude Code skill. Putting them under /me/settings
// behind a Studio tab implied a workspace scope that doesn't exist.
//
// Used for headless integrations: the Claude Code skill, the Floom CLI,
// scripts, and MCP clients. Backed by Better Auth's api-key plugin
// (see apps/server/src/lib/better-auth.ts), which auto-resolves the caller
// from `Authorization: Bearer <key>` (or x-api-key) on any /api/* route.
//
// Three flows on this page:
//
//   1. Empty state  — "No API keys yet." + Create button.
//   2. Create       — inline form (name input). On submit, `/auth/api-key/create`
//                     returns the full cleartext key ONCE. We render it in a
//                     copy-to-clipboard callout with a "You won't see this again"
//                     line. The cleartext is never persisted to React state
//                     past this render and never refetchable from the list.
//   3. List + revoke — table of keys (name, created, last used, Revoke). Revoke
//                     is an inline confirm (no modal), per spec.
//
// Hard constraints:
//   - Display-once is truly one-shot; after the user dismisses the callout
//     (or navigates away) there is no code path that returns the cleartext.
//   - No emojis, no colored left borders, real SVG icons.
//   - Matches v17 palette via the shared `var(--*)` custom properties.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageShell } from '../components/PageShell';
import * as api from '../api/client';
import type { ApiKeyRecord, CreatedApiKey } from '../api/client';

export function MeSettingsTokensPage() {
  const [keys, setKeys] = useState<ApiKeyRecord[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createState, setCreateState] = useState<'idle' | 'creating' | 'error'>('idle');
  const [createError, setCreateError] = useState('');
  // The freshly-minted cleartext key, shown once then forgotten. Stored in
  // local state only for the current render; not in sessionStorage, not in
  // a ref that survives unmount.
  const [justCreated, setJustCreated] = useState<CreatedApiKey | null>(null);
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const [revokeState, setRevokeState] = useState<'idle' | 'revoking'>('idle');

  async function loadKeys() {
    try {
      const list = await api.listApiKeys();
      // Sort newest-first so the most recent create surfaces at the top.
      list.sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
      setKeys(list);
      setLoadError(null);
    } catch (err) {
      setKeys([]);
      setLoadError((err as Error).message || 'Failed to load keys');
    }
  }

  useEffect(() => {
    loadKeys();
  }, []);

  async function handleCreate(e: React.FormEvent) {
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
      setCreateError((err as Error).message || 'Failed to create key');
    }
  }

  async function handleRevoke(keyId: string) {
    setRevokeState('revoking');
    try {
      await api.deleteApiKey(keyId);
      setRevokeId(null);
      setRevokeState('idle');
      await loadKeys();
    } catch (err) {
      setLoadError((err as Error).message || 'Failed to revoke key');
      setRevokeId(null);
      setRevokeState('idle');
    }
  }

  return (
    <PageShell requireAuth="cloud" title="API keys | Floom" noIndex>
      <div data-testid="tokens-page" style={{ maxWidth: 720 }}>
        <nav
          aria-label="Breadcrumb"
          style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 16 }}
        >
          <Link to="/me" style={{ color: 'var(--muted)', textDecoration: 'none' }}>
            /me
          </Link>
          <span style={{ margin: '0 6px' }}>›</span>
          <span style={{ color: 'var(--ink)' }}>API keys</span>
        </nav>

        <div style={{ marginBottom: 24 }}>
          <h1 style={{ fontSize: 26, fontWeight: 700, margin: '0 0 6px', color: 'var(--ink)' }}>
            API keys
          </h1>
          <p style={{ fontSize: 14, color: 'var(--muted)', margin: 0, lineHeight: 1.55 }}>
            Use these to call Floom from scripts, the Claude Code skill, or any
            MCP client. Send them as{' '}
            <code style={codeStyle}>Authorization: Bearer &lt;key&gt;</code>.
          </p>
        </div>

        {justCreated && (
          <DisplayOnceCallout
            created={justCreated}
            onDismiss={() => setJustCreated(null)}
          />
        )}

        <section
          data-testid="tokens-card"
          style={{
            background: 'var(--card)',
            border: '1px solid var(--line)',
            borderRadius: 14,
            padding: '22px 24px',
            marginBottom: 18,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              flexWrap: 'wrap',
              marginBottom: 16,
            }}
          >
            <h2
              style={{
                fontSize: 15,
                fontWeight: 700,
                color: 'var(--ink)',
                margin: 0,
              }}
            >
              Your keys
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
                style={primaryButtonStyle(true)}
              >
                Create key
              </button>
            )}
          </div>

          {showCreate && (
            <form
              onSubmit={handleCreate}
              data-testid="tokens-create-form"
              style={{
                display: 'flex',
                gap: 8,
                flexWrap: 'wrap',
                marginBottom: 20,
                padding: '14px 16px',
                border: '1px solid var(--line)',
                borderRadius: 10,
                background: 'var(--bg)',
              }}
            >
              <input
                autoFocus
                data-testid="tokens-create-name"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder="Name, e.g. 'laptop-cli' or 'github-actions'"
                maxLength={64}
                style={{
                  flex: 1,
                  minWidth: 220,
                  padding: '9px 12px',
                  border: '1px solid var(--line)',
                  borderRadius: 8,
                  fontSize: 13,
                  background: 'var(--card)',
                  color: 'var(--ink)',
                  fontFamily: 'inherit',
                }}
              />
              <button
                type="submit"
                disabled={createState === 'creating' || !createName.trim()}
                data-testid="tokens-create-submit"
                style={primaryButtonStyle(
                  createState !== 'creating' && !!createName.trim(),
                )}
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
                style={secondaryButtonStyle}
              >
                Cancel
              </button>
              {createError && (
                <div
                  data-testid="tokens-create-error"
                  style={{ fontSize: 12, color: '#c2321f', width: '100%' }}
                >
                  {createError}
                </div>
              )}
            </form>
          )}

          {loadError && (
            <div
              style={{
                background: '#fff7ed',
                border: '1px solid #fcd9a8',
                color: '#9a4a00',
                padding: '10px 14px',
                borderRadius: 8,
                fontSize: 13,
                marginBottom: 16,
              }}
            >
              {loadError}
            </div>
          )}

          {keys === null ? (
            <div style={placeholderStyle}>Loading…</div>
          ) : keys.length === 0 ? (
            <div data-testid="tokens-empty" style={emptyStyle}>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)', marginBottom: 6 }}>
                No API keys yet
              </div>
              <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.55 }}>
                Create your first key to use Floom from the CLI, the Claude Code
                skill, or any MCP client.
              </div>
            </div>
          ) : (
            <div
              data-testid="tokens-list"
              role="table"
              aria-label="API keys"
              style={{ display: 'flex', flexDirection: 'column' }}
            >
              <div
                role="row"
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1.3fr 0.9fr 0.9fr auto',
                  gap: 12,
                  padding: '8px 4px',
                  fontSize: 11,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  color: 'var(--muted)',
                  borderBottom: '1px solid var(--line)',
                }}
              >
                <span role="columnheader">Name</span>
                <span role="columnheader">Created</span>
                <span role="columnheader">Last used</span>
                <span role="columnheader" style={{ textAlign: 'right' }}>
                  Actions
                </span>
              </div>
              {keys.map((k) => (
                <KeyRow
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
        </section>

        <p style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.55, maxWidth: 620 }}>
          Keys are hashed at rest and only shown in full at creation time.
          Revoking a key takes effect immediately on the next request.
        </p>
      </div>
    </PageShell>
  );
}

// -------- Display-once callout --------

function DisplayOnceCallout({
  created,
  onDismiss,
}: {
  created: CreatedApiKey;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(created.key);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API denied — user can still triple-click the input.
    }
  }

  return (
    <section
      data-testid="tokens-display-once"
      style={{
        background: 'var(--accent-soft)',
        border: '1px solid var(--accent-border)',
        borderRadius: 14,
        padding: '20px 22px',
        marginBottom: 18,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          marginBottom: 8,
        }}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
          style={{ color: 'var(--accent)', flexShrink: 0 }}
        >
          <path
            d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5Zm-3 8V7a3 3 0 1 1 6 0v3H9Z"
            fill="currentColor"
          />
        </svg>
        <h3
          style={{
            fontSize: 14,
            fontWeight: 700,
            color: 'var(--accent)',
            margin: 0,
          }}
        >
          Key created — copy it now
        </h3>
      </div>
      <p
        style={{
          fontSize: 13,
          color: 'var(--ink)',
          margin: '0 0 14px',
          lineHeight: 1.55,
        }}
      >
        You won&apos;t see this key again. Store it somewhere safe (a password
        manager or your shell rc file).
      </p>

      <div
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          marginBottom: 12,
          flexWrap: 'wrap',
        }}
      >
        <input
          data-testid="tokens-display-once-value"
          readOnly
          value={created.key}
          onFocus={(e) => e.currentTarget.select()}
          style={{
            flex: 1,
            minWidth: 260,
            padding: '9px 12px',
            border: '1px solid var(--accent-border)',
            borderRadius: 8,
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 12,
            background: 'var(--card)',
            color: 'var(--ink)',
            boxSizing: 'border-box',
          }}
        />
        <button
          type="button"
          onClick={copy}
          data-testid="tokens-display-once-copy"
          style={primaryButtonStyle(true)}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      <div
        style={{
          background: 'var(--card)',
          border: '1px solid var(--accent-border)',
          borderRadius: 8,
          padding: '12px 14px',
          fontSize: 12,
          color: 'var(--ink)',
          lineHeight: 1.6,
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Quick start</div>
        <code
          style={{
            display: 'block',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 12,
            background: 'var(--bg)',
            padding: '8px 10px',
            borderRadius: 6,
            border: '1px solid var(--line)',
            marginBottom: 8,
            overflowX: 'auto',
          }}
        >
          export FLOOM_API_KEY={created.key.slice(0, 10)}…
        </code>
        <div style={{ color: 'var(--muted)' }}>
          Pair it with the{' '}
          <a
            href="https://github.com/floomhq/floom/tree/main/skills/claude-code"
            target="_blank"
            rel="noreferrer"
            style={{ color: 'var(--accent)', textDecoration: 'underline' }}
          >
            Claude Code skill
          </a>{' '}
          for in-terminal Floom calls.
        </div>
      </div>

      <div style={{ marginTop: 14, textAlign: 'right' }}>
        <button
          type="button"
          onClick={onDismiss}
          data-testid="tokens-display-once-dismiss"
          style={secondaryButtonStyle}
        >
          I&apos;ve saved it
        </button>
      </div>
    </section>
  );
}

// -------- Table row --------

interface KeyRowProps {
  record: ApiKeyRecord;
  isConfirming: boolean;
  isRevoking: boolean;
  onRevokeClick: () => void;
  onRevokeCancel: () => void;
  onRevokeConfirm: () => void;
}

function KeyRow({
  record,
  isConfirming,
  isRevoking,
  onRevokeClick,
  onRevokeCancel,
  onRevokeConfirm,
}: KeyRowProps) {
  const label = record.name || '(unnamed)';
  const preview = record.start ? `${record.start}…` : record.prefix || '';

  return (
    <div
      role="row"
      data-testid={`tokens-row-${record.id}`}
      style={{
        display: 'grid',
        gridTemplateColumns: '1.3fr 0.9fr 0.9fr auto',
        gap: 12,
        padding: '14px 4px',
        alignItems: 'center',
        fontSize: 13,
        color: 'var(--ink)',
        borderBottom: '1px solid var(--line)',
      }}
    >
      <div role="cell" style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {label}
        </span>
        {preview && (
          <code
            style={{
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 11,
              color: 'var(--muted)',
            }}
          >
            {preview}
          </code>
        )}
      </div>
      <div role="cell" style={{ fontSize: 12, color: 'var(--muted)' }}>
        {formatRelative(record.createdAt)}
      </div>
      <div role="cell" style={{ fontSize: 12, color: 'var(--muted)' }}>
        {record.lastRequest ? formatRelative(record.lastRequest) : '—'}
      </div>
      <div role="cell" style={{ textAlign: 'right' }}>
        {isConfirming ? (
          <span style={{ display: 'inline-flex', gap: 6 }}>
            <button
              type="button"
              onClick={onRevokeCancel}
              disabled={isRevoking}
              data-testid={`tokens-revoke-cancel-${record.id}`}
              style={secondaryButtonStyle}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onRevokeConfirm}
              disabled={isRevoking}
              data-testid={`tokens-revoke-confirm-${record.id}`}
              style={{
                ...secondaryButtonStyle,
                color: '#c2321f',
                borderColor: '#f4b7b1',
              }}
            >
              {isRevoking ? 'Revoking…' : 'Confirm revoke'}
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={onRevokeClick}
            data-testid={`tokens-revoke-${record.id}`}
            style={{
              ...secondaryButtonStyle,
              color: '#c2321f',
              borderColor: 'var(--line)',
            }}
          >
            Revoke
          </button>
        )}
      </div>
    </div>
  );
}

// -------- Shared style snippets --------

function primaryButtonStyle(active: boolean): React.CSSProperties {
  return {
    padding: '9px 16px',
    background: 'var(--ink)',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    cursor: active ? 'pointer' : 'not-allowed',
    fontFamily: 'inherit',
    opacity: active ? 1 : 0.5,
  };
}

const secondaryButtonStyle: React.CSSProperties = {
  padding: '8px 14px',
  background: 'var(--card)',
  color: 'var(--ink)',
  border: '1px solid var(--line)',
  borderRadius: 8,
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const emptyStyle: React.CSSProperties = {
  border: '1px dashed var(--line)',
  borderRadius: 10,
  padding: '28px 24px',
  background: 'var(--card)',
  textAlign: 'center',
};

const placeholderStyle: React.CSSProperties = {
  padding: '20px 0',
  fontSize: 13,
  color: 'var(--muted)',
};

const codeStyle: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 12,
  background: 'var(--bg)',
  padding: '1px 6px',
  borderRadius: 4,
  border: '1px solid var(--line)',
};

/** Minimal relative-time formatter — seconds/minutes/hours/days, then date.
 *  Kept local to avoid a dep on a 30 KB formatter for one surface. */
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
