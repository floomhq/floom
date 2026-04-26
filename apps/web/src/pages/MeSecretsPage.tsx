// /me/secrets — BYOK keys (Bring Your Own Keys).
//
// v23 vocabulary lock: this page is "BYOK keys" everywhere user-visible.
// NOT "Secrets", NOT "API keys" — those words are banned from the H1,
// subhead, callouts, and labels on this surface.
//
// What it does: lists the user's provider keys (Gemini / OpenAI /
// Anthropic / custom env vars an installed app declares) so they can run
// AI apps using their own quota. Storage is server-side, encrypted at
// rest with aes-256-gcm (verified at apps/server/src/services/user_secrets.ts:124),
// and only decrypted at run time.
//
// Backed by `useSecrets()` (apps/web/src/hooks/useSecrets.ts) which lists
// masked entries (key + updated_at, never plaintext), saves/replaces a
// value, and removes a key.
//
// "Used by" pills: derived client-side from the currently-installed apps
// (`useMyApps()`). Today CreatorApp doesn't expose `secrets_needed` to
// the client, so the pill row falls back to "no apps installed yet"
// when the manifest data isn't available — graceful, not fake. Once the
// hub endpoint emits manifest.secrets[], the pills wire up to real apps.

import { useMemo, useState, type CSSProperties } from 'react';
import { MeLayout } from '../components/me/MeLayout';
import { MeTabStrip } from '../components/me/MeTabStrip';
import { useSession } from '../hooks/useSession';
import { useMyApps } from '../hooks/useMyApps';
import { useSecrets } from '../hooks/useSecrets';

// Provider catalogue. Sets the display name + the env-var key the
// underlying secrets store uses. "+ Add another key" can target any of
// these or accept a custom env-var key for power users.
const PROVIDERS: Array<{
  id: string;
  name: string;
  envKey: string;
  hint: string;
}> = [
  {
    id: 'gemini',
    name: 'Gemini key',
    envKey: 'GEMINI_API_KEY',
    hint: 'Google AI Studio key. Used by AI apps that call Gemini.',
  },
  {
    id: 'openai',
    name: 'OpenAI key',
    envKey: 'OPENAI_API_KEY',
    hint: 'OpenAI platform key. Used by AI apps that call GPT.',
  },
  {
    id: 'anthropic',
    name: 'Anthropic key',
    envKey: 'ANTHROPIC_API_KEY',
    hint: 'Anthropic console key. Used by AI apps that call Claude.',
  },
];

const KNOWN_ENV_KEYS = new Set(PROVIDERS.map((p) => p.envKey));

// Mask a key like AIzaSy…3f2a. We don't have the value (server never
// returns it) so we just render a placeholder mask + the env-var name.
// Once the masked-prefix shape lands on the secrets list endpoint we'll
// replace this with real prefix/suffix.
function maskedFromKey(envKey: string): string {
  return `${envKey.slice(0, 6)}…••••`;
}

const styles: Record<string, CSSProperties> = {
  head: { marginBottom: 24 },
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
    width: 40,
    height: 40,
    borderRadius: 11,
    background: 'var(--accent-soft)',
    color: 'var(--accent)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  cardName: {
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--ink)',
  },
  cardValue: {
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 11.5,
    color: 'var(--muted)',
    marginTop: 3,
  },
  usedByRow: {
    fontSize: 11.5,
    color: 'var(--muted)',
    marginTop: 6,
    display: 'flex',
    gap: 6,
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  usedByPill: {
    fontSize: 10.5,
    padding: '2px 7px',
    background: 'var(--accent-soft)',
    color: 'var(--accent)',
    border: '1px solid var(--accent-border, #d1fae5)',
    borderRadius: 6,
    fontWeight: 600,
  },
  usedByEmpty: {
    color: 'var(--muted)',
    fontStyle: 'italic',
  },
  actions: { display: 'flex', gap: 6 },
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
  addTile: {
    marginTop: 14,
    padding: '20px 22px',
    border: '1.5px dashed var(--line)',
    borderRadius: 14,
    background: 'var(--bg)',
    textAlign: 'center',
    color: 'var(--muted)',
    fontSize: 13,
    cursor: 'pointer',
    width: '100%',
    fontFamily: 'inherit',
  },
  addTileStrong: {
    color: 'var(--ink)',
    fontWeight: 600,
  },
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
    borderRadius: 18,
    boxShadow: '0 24px 64px -24px rgba(14, 14, 12, 0.32)',
    width: '100%',
    maxWidth: 460,
    overflow: 'hidden',
  },
  modalHead: {
    padding: '18px 22px',
    borderBottom: '1px solid var(--line)',
  },
  modalTitle: {
    fontFamily: 'var(--font-display)',
    fontWeight: 800,
    fontSize: 18,
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
  modalBody: { padding: '18px 22px' },
  modalFoot: {
    padding: '14px 22px',
    background: 'var(--bg)',
    borderTop: '1px solid var(--line)',
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 8,
  },
  label: {
    display: 'block',
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--ink)',
    marginBottom: 6,
  },
  input: {
    width: '100%',
    padding: '9px 12px',
    border: '1px solid var(--line)',
    borderRadius: 8,
    fontSize: 13,
    background: 'var(--card)',
    color: 'var(--ink)',
    fontFamily: 'inherit',
    boxSizing: 'border-box',
  },
  select: {
    width: '100%',
    padding: '9px 12px',
    border: '1px solid var(--line)',
    borderRadius: 8,
    fontSize: 13,
    background: 'var(--card)',
    color: 'var(--ink)',
    fontFamily: 'inherit',
    boxSizing: 'border-box',
  },
  hint: {
    fontSize: 11.5,
    color: 'var(--muted)',
    marginTop: 6,
    lineHeight: 1.45,
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
  removeConfirmRow: {
    display: 'flex',
    gap: 6,
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
};

interface SecretEntry {
  envKey: string;
  updatedAt: string | null;
  isProvider: boolean;
  providerId: string | null;
  displayName: string;
}

export function MeSecretsPage() {
  const { data: session } = useSession();
  const { apps } = useMyApps();
  const { entries, loading, error, save, remove } = useSecrets();
  const signedOutPreview = !!session && session.cloud_mode && session.user.is_local;

  const [modalOpen, setModalOpen] = useState<
    | null
    | {
        mode: 'add' | 'rotate';
        providerId?: string;
        envKey?: string;
        displayName?: string;
      }
  >(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [busyEnvKey, setBusyEnvKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Build the displayable rows: prefer the provider catalogue order,
  // then any custom env-var keys the user has stored. Each entry maps
  // back to a `useSecrets()` row by envKey.
  const rows = useMemo<SecretEntry[]>(() => {
    const byKey = new Map<string, { updated_at: string | null }>();
    (entries ?? []).forEach((e) => byKey.set(e.key, e));

    const providerRows: SecretEntry[] = PROVIDERS.filter((p) => byKey.has(p.envKey)).map(
      (p) => ({
        envKey: p.envKey,
        updatedAt: byKey.get(p.envKey)?.updated_at ?? null,
        isProvider: true,
        providerId: p.id,
        displayName: p.name,
      }),
    );

    const customRows: SecretEntry[] = (entries ?? [])
      .filter((e) => !KNOWN_ENV_KEYS.has(e.key))
      .map((e) => ({
        envKey: e.key,
        updatedAt: e.updated_at,
        isProvider: false,
        providerId: null,
        displayName: e.key,
      }));

    return [...providerRows, ...customRows];
  }, [entries]);

  // "Used by" derivation. CreatorApp doesn't currently expose
  // manifest.secrets[] to the client, so we render the empty fallback
  // until the hub endpoint adds it. Once it's available, replace this
  // body with a filter on app.secrets_needed?.includes(envKey).
  function usedByApps(_envKey: string): Array<{ slug: string; name: string }> {
    void _envKey;
    void apps;
    return [];
  }

  async function handleSave(envKey: string, value: string): Promise<void> {
    setActionError(null);
    setBusyEnvKey(envKey);
    try {
      await save(envKey, value);
      setModalOpen(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyEnvKey(null);
    }
  }

  async function handleRemove(envKey: string): Promise<void> {
    setActionError(null);
    setBusyEnvKey(envKey);
    try {
      await remove(envKey);
      setConfirmRemove(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyEnvKey(null);
    }
  }

  return (
    <MeLayout
      activeTab="secrets"
      title="BYOK keys · Floom"
      headerVariant="none"
      maxWidth={880}
      allowSignedOutShell={signedOutPreview}
    >
      <div data-testid="me-secrets-page">
        <div style={styles.head}>
          <h1 style={styles.h1}>BYOK keys</h1>
          <p style={styles.subhead}>
            Your provider keys (Gemini, OpenAI, Anthropic). Bring your own for
            unlimited runs on AI apps. Encrypted at rest (aes-256-gcm
            envelope) and only decrypted at run time.
          </p>
        </div>

        <MeTabStrip
          active="secrets"
          counts={{
            apps: apps?.length,
            secrets: entries?.length,
          }}
        />

        {actionError && (
          <div role="alert" style={styles.errorBanner}>
            {actionError}
          </div>
        )}

        {error && (
          <div role="alert" style={styles.errorBanner}>
            {error.message || 'Failed to load BYOK keys.'}
          </div>
        )}

        {signedOutPreview ? (
          <div style={styles.emptyState}>Sign in to manage your BYOK keys.</div>
        ) : loading && !entries ? (
          <div style={styles.emptyState}>Loading…</div>
        ) : rows.length === 0 ? (
          <div data-testid="me-byok-keys-empty" style={styles.emptyState}>
            No BYOK keys yet. Add a Gemini, OpenAI, or Anthropic key below to
            run AI apps for free.
          </div>
        ) : (
          <div data-testid="me-byok-keys-list">
            {rows.map((row) => {
              const used = usedByApps(row.envKey);
              const isConfirmingRemove = confirmRemove === row.envKey;
              const isBusy = busyEnvKey === row.envKey;
              return (
                <div
                  key={row.envKey}
                  data-testid={`me-byok-key-${row.providerId ?? row.envKey}`}
                  style={styles.card}
                >
                  <span aria-hidden style={styles.iconWrap}>
                    <KeyIcon />
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div style={styles.cardName}>{row.displayName}</div>
                    <div style={styles.cardValue}>
                      {maskedFromKey(row.envKey)}
                      {row.updatedAt
                        ? ` · updated ${formatRelative(row.updatedAt)}`
                        : ''}
                    </div>
                    <div style={styles.usedByRow}>
                      <span>Used by:</span>
                      {used.length === 0 ? (
                        <span style={styles.usedByEmpty}>
                          no apps installed yet
                        </span>
                      ) : (
                        used.map((app) => (
                          <span key={app.slug} style={styles.usedByPill}>
                            {app.name}
                          </span>
                        ))
                      )}
                    </div>
                  </div>
                  <div style={styles.actions}>
                    {isConfirmingRemove ? (
                      <div style={styles.removeConfirmRow}>
                        <button
                          type="button"
                          onClick={() => setConfirmRemove(null)}
                          disabled={isBusy}
                          style={styles.btnSecondary}
                          data-testid={`me-byok-key-${row.providerId ?? row.envKey}-remove-cancel`}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRemove(row.envKey)}
                          disabled={isBusy}
                          style={styles.btnGhostDanger}
                          data-testid={`me-byok-key-${row.providerId ?? row.envKey}-remove-confirm`}
                        >
                          {isBusy ? 'Removing…' : 'Confirm remove'}
                        </button>
                      </div>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() =>
                            setModalOpen({
                              mode: 'rotate',
                              envKey: row.envKey,
                              providerId: row.providerId ?? undefined,
                              displayName: row.displayName,
                            })
                          }
                          style={styles.btnSecondary}
                          data-testid={`me-byok-key-${row.providerId ?? row.envKey}-rotate`}
                        >
                          Rotate
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmRemove(row.envKey)}
                          style={styles.btnGhostDanger}
                          data-testid={`me-byok-key-${row.providerId ?? row.envKey}-remove`}
                        >
                          Remove
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {!signedOutPreview && (
          <button
            type="button"
            onClick={() => setModalOpen({ mode: 'add' })}
            style={styles.addTile}
            data-testid="me-byok-keys-add"
          >
            <strong style={styles.addTileStrong}>+ Add another key</strong> ·
            Gemini, OpenAI, Anthropic, or any custom env var an app declares.
          </button>
        )}

        {modalOpen && (
          <KeyModal
            mode={modalOpen.mode}
            initialProviderId={modalOpen.providerId}
            initialEnvKey={modalOpen.envKey}
            initialDisplayName={modalOpen.displayName}
            existingEnvKeys={(entries ?? []).map((e) => e.key)}
            busy={!!busyEnvKey}
            onSave={handleSave}
            onClose={() => {
              setModalOpen(null);
              setActionError(null);
            }}
          />
        )}
      </div>
    </MeLayout>
  );
}

// -------- Provider/custom key modal (Add or Rotate) --------

function KeyModal({
  mode,
  initialProviderId,
  initialEnvKey,
  initialDisplayName,
  existingEnvKeys,
  busy,
  onSave,
  onClose,
}: {
  mode: 'add' | 'rotate';
  initialProviderId?: string;
  initialEnvKey?: string;
  initialDisplayName?: string;
  existingEnvKeys: string[];
  busy: boolean;
  onSave: (envKey: string, value: string) => Promise<void>;
  onClose: () => void;
}) {
  const [providerId, setProviderId] = useState<string>(
    initialProviderId ?? PROVIDERS[0].id,
  );
  const [customEnvKey, setCustomEnvKey] = useState<string>(
    !initialProviderId && initialEnvKey ? initialEnvKey : '',
  );
  const [value, setValue] = useState('');

  const isCustom = mode === 'add' && providerId === '__custom__';
  const provider =
    mode === 'rotate' && initialEnvKey
      ? PROVIDERS.find((p) => p.envKey === initialEnvKey) ?? null
      : isCustom
      ? null
      : PROVIDERS.find((p) => p.id === providerId) ?? PROVIDERS[0];

  const envKey =
    mode === 'rotate' && initialEnvKey
      ? initialEnvKey
      : isCustom
      ? customEnvKey.trim()
      : provider?.envKey ?? '';

  const displayName =
    mode === 'rotate' && initialDisplayName
      ? initialDisplayName
      : isCustom
      ? customEnvKey.trim() || 'Custom env var'
      : provider?.name ?? '';

  const valid =
    !!envKey &&
    !!value.trim() &&
    (mode === 'rotate' || isCustom || !existingEnvKeys.includes(envKey));

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!valid) return;
    await onSave(envKey, value);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="me-byok-modal-title"
      style={styles.modalBackdrop}
      onClick={onClose}
    >
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        style={styles.modal}
        data-testid="me-byok-keys-modal"
      >
        <div style={styles.modalHead}>
          <h3 id="me-byok-modal-title" style={styles.modalTitle}>
            {mode === 'rotate'
              ? `Replace your ${displayName}`
              : 'Add a BYOK key'}
          </h3>
          <p style={styles.modalSub}>
            {mode === 'rotate'
              ? 'Paste the new value. The existing one is replaced — there is no rollback.'
              : 'Pick a provider or enter a custom env-var name. Stored encrypted with aes-256-gcm; only decrypted at run time.'}
          </p>
        </div>
        <div style={styles.modalBody}>
          {mode === 'add' && (
            <div style={{ marginBottom: 14 }}>
              <label style={styles.label} htmlFor="me-byok-provider">
                Provider
              </label>
              <select
                id="me-byok-provider"
                value={providerId}
                onChange={(e) => setProviderId(e.target.value)}
                style={styles.select}
                data-testid="me-byok-keys-modal-provider"
              >
                {PROVIDERS.filter(
                  (p) => !existingEnvKeys.includes(p.envKey),
                ).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.envKey})
                  </option>
                ))}
                <option value="__custom__">
                  Custom env var (advanced)
                </option>
              </select>
              {provider?.hint && !isCustom ? (
                <div style={styles.hint}>{provider.hint}</div>
              ) : null}
            </div>
          )}

          {mode === 'add' && isCustom && (
            <div style={{ marginBottom: 14 }}>
              <label style={styles.label} htmlFor="me-byok-custom">
                Env var name
              </label>
              <input
                id="me-byok-custom"
                value={customEnvKey}
                onChange={(e) =>
                  setCustomEnvKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))
                }
                placeholder="MY_CUSTOM_KEY"
                style={styles.input}
                data-testid="me-byok-keys-modal-custom-name"
              />
              <div style={styles.hint}>
                Uppercase letters, digits, and underscores. Apps that declare
                this env var in their manifest will be able to consume the
                value.
              </div>
            </div>
          )}

          <div>
            <label style={styles.label} htmlFor="me-byok-value">
              Value
            </label>
            <input
              id="me-byok-value"
              type="password"
              autoComplete="off"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={
                provider?.envKey === 'GEMINI_API_KEY'
                  ? 'AIzaSy…'
                  : provider?.envKey === 'OPENAI_API_KEY'
                  ? 'sk-…'
                  : provider?.envKey === 'ANTHROPIC_API_KEY'
                  ? 'sk-ant-…'
                  : 'Paste your key'
              }
              style={styles.input}
              autoFocus
              data-testid="me-byok-keys-modal-value"
            />
            <div style={styles.hint}>
              Stored server-side, encrypted at rest. Floom never logs the
              plaintext value.
            </div>
          </div>
        </div>
        <div style={styles.modalFoot}>
          <button
            type="button"
            onClick={onClose}
            style={styles.btnSecondary}
            disabled={busy}
            data-testid="me-byok-keys-modal-cancel"
          >
            Cancel
          </button>
          <button
            type="submit"
            style={valid && !busy ? styles.btnAccent : styles.btnAccentDisabled}
            disabled={!valid || busy}
            data-testid="me-byok-keys-modal-save"
          >
            {busy ? 'Saving…' : mode === 'rotate' ? 'Replace key' : 'Save key'}
          </button>
        </div>
      </form>
    </div>
  );
}

// -------- Tiny helpers --------

function KeyIcon() {
  return (
    <svg
      width={20}
      height={20}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      aria-hidden="true"
    >
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11 V7 a5 5 0 0 1 10 0 v4" />
    </svg>
  );
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
