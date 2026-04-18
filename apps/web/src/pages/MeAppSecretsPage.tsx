// /me/apps/:slug/secrets — per-app, per-secret policy + vault UI.
//
// Two views:
//
//   Creator view (session.user.id === app.author):
//     One row per key in manifest.secrets_needed. Each row has a
//     segmented policy toggle between "I provide for all users"
//     (creator_override) and "Each user provides their own"
//     (user_vault). When the policy is creator_override the row
//     shows a value input + Save + Delete pointing at the new
//     /api/me/apps/:slug/creator-secrets/:key endpoint. When the
//     policy is user_vault the row is a read-only explainer — the
//     creator does not set the value; each user sets it in their
//     own vault.
//
//   Non-creator view (anyone else):
//     Only the user_vault keys are rendered. creator_override keys
//     are hidden entirely so the user is never asked for a value the
//     creator has already provided. The vault UI is the existing
//     SecretRow component powered by `useSecrets`.
//
// Toggle is optimistic: the UI flips instantly, fires the PUT, and
// rolls back + surfaces a compact inline error on failure. When a
// creator switches user_vault → creator_override and no value has been
// stored yet, the value input auto-focuses so they can save right away.

import { useEffect, useState, useRef } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { PageShell } from '../components/PageShell';
import { MeRail } from '../components/me/MeRail';
import { StudioLayout } from '../components/studio/StudioLayout';
import { AppHeader, TabBar } from './MeAppPage';
import { useSecrets } from '../hooks/useSecrets';
import { useSession } from '../hooks/useSession';
import * as api from '../api/client';
import type {
  AppDetail,
  UserSecretEntry,
  SecretPolicy,
  SecretPolicyEntry,
} from '../lib/types';

interface MeAppSecretsPageProps {
  /** Route chrome wrapper. Defaults to PageShell + MeRail. Studio
   *  passes a StudioLayout adapter so the same body renders inside the
   *  creator workspace (no TabBar — sidebar handles navigation). */
  chrome?: 'me' | 'studio';
  /** On 404 redirect to this path. Defaults to /me. */
  notFoundPath?: string;
}

export function MeAppSecretsPage({
  chrome = 'me',
  notFoundPath,
}: MeAppSecretsPageProps = {}) {
  const { slug } = useParams<{ slug: string }>();
  const nav = useNavigate();
  const [app, setApp] = useState<AppDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [policies, setPolicies] = useState<SecretPolicyEntry[] | null>(null);
  const [policiesError, setPoliciesError] = useState<string | null>(null);
  const secrets = useSecrets();
  const session = useSession();

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    api
      .getApp(slug)
      .then((res) => {
        if (!cancelled) setApp(res);
      })
      .catch((err) => {
        if (cancelled) return;
        const status = (err as { status?: number }).status;
        if (status === 404) {
          nav(notFoundPath ?? '/me', { replace: true });
          return;
        }
        if (status === 403 && chrome === 'studio') {
          nav(`/p/${slug}`, { replace: true });
          return;
        }
        setError((err as Error).message || 'Failed to load app');
      });
    return () => {
      cancelled = true;
    };
  }, [slug, nav, notFoundPath, chrome]);

  // Load policies once we know the app exists. A 403 here would mean the
  // caller can't even view the app; in practice /api/hub/:slug would have
  // 404'd first, so we just surface the message inline.
  useEffect(() => {
    if (!slug || !app) return;
    let cancelled = false;
    api
      .getSecretPolicies(slug)
      .then((res) => {
        if (!cancelled) setPolicies(res.policies);
      })
      .catch((err) => {
        if (cancelled) return;
        setPoliciesError(
          (err as Error).message || 'Failed to load secret policies',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [slug, app]);

  const neededKeys = app?.manifest?.secrets_needed ?? [];

  // Ownership: in OSS mode both `author` and the session user id are
  // 'local' so the creator view is shown by default. In Cloud mode the
  // author must match the authenticated user's id.
  const sessionUserId = session.data?.user?.id ?? null;
  const isCreator = Boolean(
    app?.author && sessionUserId && app.author === sessionUserId,
  );

  // Default-filled policy list so the UI can render deterministically
  // even before the policies call lands (the API is fast but we want
  // no flicker on first paint).
  const policyByKey = new Map<string, SecretPolicyEntry>(
    (policies ?? []).map((p) => [p.key, p]),
  );
  const resolvedPolicies: SecretPolicyEntry[] = neededKeys.map(
    (key) =>
      policyByKey.get(key) ?? {
        key,
        policy: 'user_vault' as SecretPolicy,
        creator_has_value: false,
      },
  );

  // Non-creator view hides creator_override keys entirely — users never
  // need to know they exist because the creator has taken ownership.
  const visibleForViewer = resolvedPolicies.filter(
    (p) => p.policy === 'user_vault',
  );

  const body = (
    <>
      {chrome === 'me' && (
        <nav
          aria-label="Breadcrumb"
          style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 16 }}
        >
          <Link to="/me" style={{ color: 'var(--muted)', textDecoration: 'none' }}>
            /me
          </Link>
          <span style={{ margin: '0 6px' }}>›</span>
          {app ? (
            <Link
              to={`/me/apps/${app.slug}`}
              style={{ color: 'var(--muted)', textDecoration: 'none' }}
            >
              {app.name}
            </Link>
          ) : (
            <span>{slug}</span>
          )}
          <span style={{ margin: '0 6px' }}>›</span>
          <span style={{ color: 'var(--ink)' }}>Secrets</span>
        </nav>
      )}
      {chrome === 'studio' && app && (
        <nav
          aria-label="Breadcrumb"
          style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 16 }}
        >
          <Link
            to={`/studio/${app.slug}`}
            style={{ color: 'var(--muted)', textDecoration: 'none' }}
          >
            {app.name}
          </Link>
          <span style={{ margin: '0 6px' }}>›</span>
          <span style={{ color: 'var(--ink)' }}>Secrets</span>
        </nav>
      )}

          {error && (
            <div
              style={{
                background: '#fdecea',
                border: '1px solid #f4b7b1',
                color: '#c2321f',
                padding: '10px 14px',
                borderRadius: 8,
                fontSize: 13,
                marginBottom: 20,
              }}
            >
              {error}
            </div>
          )}

          {app && (
            <>
              <AppHeader app={app} />
              {chrome === 'me' && <TabBar slug={app.slug} active="secrets" />}

              <h2
                style={{
                  fontSize: 16,
                  fontWeight: 700,
                  color: 'var(--ink)',
                  margin: chrome === 'studio' ? '20px 0 4px' : '0 0 4px',
                }}
              >
                Secrets for {app.name}
              </h2>
              <p
                style={{
                  fontSize: 13,
                  color: 'var(--muted)',
                  margin: '0 0 20px',
                  lineHeight: 1.55,
                }}
              >
                {isCreator
                  ? 'Choose how each secret is supplied. You can set a shared value yourself or leave it to each user.'
                  : 'Provide the credentials this app needs to run on your behalf. Values are write-only.'}
              </p>

              {policiesError && (
                <div
                  style={{
                    background: '#fff7ed',
                    border: '1px solid #fcd9a8',
                    color: '#9a4a00',
                    padding: '10px 14px',
                    borderRadius: 8,
                    fontSize: 13,
                    marginBottom: 20,
                  }}
                >
                  Couldn’t load secret policies: {policiesError}
                </div>
              )}

              {neededKeys.length === 0 ? (
                <div
                  data-testid="me-app-secrets-empty"
                  style={{
                    border: '1px dashed var(--line)',
                    borderRadius: 10,
                    padding: '24px 20px',
                    background: 'var(--card)',
                    fontSize: 13,
                    color: 'var(--muted)',
                  }}
                >
                  This app doesn’t declare any secrets. Nothing to configure
                  here.
                </div>
              ) : isCreator ? (
                <div
                  data-testid="me-app-secrets-list"
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 12,
                  }}
                >
                  {resolvedPolicies.map((p) => (
                    <CreatorSecretRow
                      key={p.key}
                      slug={app.slug}
                      entry={p}
                      onPolicyChanged={(next) => {
                        setPolicies((prev) => {
                          if (!prev) return prev;
                          return prev.some((x) => x.key === p.key)
                            ? prev.map((x) =>
                                x.key === p.key ? { ...x, ...next } : x,
                              )
                            : [...prev, { ...p, ...next }];
                        });
                      }}
                    />
                  ))}
                </div>
              ) : visibleForViewer.length === 0 ? (
                <div
                  data-testid="me-app-secrets-empty"
                  style={{
                    border: '1px dashed var(--line)',
                    borderRadius: 10,
                    padding: '24px 20px',
                    background: 'var(--card)',
                    fontSize: 13,
                    color: 'var(--muted)',
                  }}
                >
                  The creator of this app supplies every required secret.
                  There’s nothing for you to set here.
                </div>
              ) : (
                <div
                  data-testid="me-app-secrets-list"
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 12,
                  }}
                >
                  {visibleForViewer.map((p) => (
                    <SecretRow
                      key={p.key}
                      secretKey={p.key}
                      entry={
                        secrets.entries?.find((e) => e.key === p.key) ?? null
                      }
                      onSave={(v) => secrets.save(p.key, v)}
                      onRemove={() => secrets.remove(p.key)}
                    />
                  ))}
                </div>
              )}

              <p
                style={{
                  fontSize: 11,
                  color: 'var(--muted)',
                  marginTop: 24,
                  lineHeight: 1.5,
                  maxWidth: 620,
                }}
              >
                Secrets are AES-256 encrypted at rest and scoped to your
                account. They’re injected at run time and never logged.
              </p>
            </>
          )}
    </>
  );

  if (chrome === 'studio') {
    return (
      <StudioLayout
        title={app ? `${app.name} · Secrets · Studio` : 'Secrets · Studio'}
        activeAppSlug={slug}
        activeSubsection="secrets"
      >
        {body}
      </StudioLayout>
    );
  }

  return (
    <PageShell
      requireAuth="cloud"
      title={app ? `${app.name} · Secrets · Floom` : 'Secrets · Floom'}
      contentStyle={{ padding: 0, maxWidth: 'none', minHeight: 'auto' }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', minHeight: 'calc(100vh - 56px)' }}>
        <MeRail activeAppSlug={slug} />
        <main
          style={{
            flex: 1,
            padding: '28px 40px 120px',
            maxWidth: 1000,
            margin: '0 auto',
            width: '100%',
            minWidth: 0,
          }}
        >
          {body}
        </main>
      </div>
    </PageShell>
  );
}

// ---------------------------------------------------------------------
// Creator row: policy toggle + (when creator_override) value input.
// ---------------------------------------------------------------------

interface CreatorSecretRowProps {
  slug: string;
  entry: SecretPolicyEntry;
  onPolicyChanged: (next: Partial<SecretPolicyEntry>) => void;
}

function CreatorSecretRow({ slug, entry, onPolicyChanged }: CreatorSecretRowProps) {
  const { key } = entry;
  const [policy, setPolicy] = useState<SecretPolicy>(entry.policy);
  const [creatorHasValue, setCreatorHasValue] = useState(entry.creator_has_value);
  const [toggling, setToggling] = useState(false);
  const [toggleErr, setToggleErr] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const [valueStatus, setValueStatus] = useState<'idle' | 'saving' | 'removing'>(
    'idle',
  );
  const [valueErr, setValueErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [autoFocusSignal, setAutoFocusSignal] = useState(0);

  useEffect(() => {
    setPolicy(entry.policy);
    setCreatorHasValue(entry.creator_has_value);
  }, [entry.policy, entry.creator_has_value]);

  // Auto-focus the value input whenever we flip to creator_override and
  // no value is set yet. The signal trick forces the effect to fire even
  // when the policy state already equaled creator_override from a stale
  // initial state (e.g. after a prior delete).
  useEffect(() => {
    if (policy === 'creator_override' && !creatorHasValue && autoFocusSignal > 0) {
      inputRef.current?.focus();
    }
  }, [policy, creatorHasValue, autoFocusSignal]);

  async function handleToggle(next: SecretPolicy) {
    if (next === policy || toggling) return;
    const prev = policy;
    setPolicy(next);
    setToggling(true);
    setToggleErr(null);
    try {
      await api.setSecretPolicy(slug, key, next);
      onPolicyChanged({ policy: next });
      if (next === 'creator_override' && !creatorHasValue) {
        setAutoFocusSignal((s) => s + 1);
      }
    } catch (err) {
      setPolicy(prev);
      setToggleErr((err as Error).message || 'Failed to update policy');
    } finally {
      setToggling(false);
    }
  }

  async function handleSaveValue(e: FormEvent) {
    e.preventDefault();
    if (!value.trim()) return;
    setValueStatus('saving');
    setValueErr(null);
    try {
      await api.setCreatorSecret(slug, key, value);
      setValue('');
      setCreatorHasValue(true);
      onPolicyChanged({ creator_has_value: true });
    } catch (err) {
      setValueErr((err as Error).message || 'Failed to save');
    } finally {
      setValueStatus('idle');
    }
  }

  async function handleRemoveValue() {
    if (!window.confirm(`Remove ${key}?`)) return;
    setValueStatus('removing');
    setValueErr(null);
    try {
      await api.deleteCreatorSecret(slug, key);
      setCreatorHasValue(false);
      onPolicyChanged({ creator_has_value: false });
    } catch (err) {
      setValueErr((err as Error).message || 'Failed to remove');
    } finally {
      setValueStatus('idle');
    }
  }

  return (
    <div
      data-testid={`secret-row-${key}`}
      style={{
        background: 'var(--card)',
        border: '1px solid var(--line)',
        borderRadius: 10,
        padding: '14px 16px',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          marginBottom: 12,
          flexWrap: 'wrap',
        }}
      >
        <code
          style={{
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--ink)',
          }}
        >
          {key}
        </code>

        <div
          role="tablist"
          aria-label={`Policy for ${key}`}
          data-testid={`secret-policy-toggle-${key}`}
          style={{
            display: 'inline-flex',
            borderRadius: 999,
            border: '1px solid var(--line)',
            background: 'var(--bg)',
            padding: 2,
            marginLeft: 'auto',
            opacity: toggling ? 0.7 : 1,
          }}
        >
          <PolicyChip
            testId={`secret-policy-creator-${key}`}
            selected={policy === 'creator_override'}
            onClick={() => handleToggle('creator_override')}
            disabled={toggling}
          >
            I provide for all users
          </PolicyChip>
          <PolicyChip
            testId={`secret-policy-user-${key}`}
            selected={policy === 'user_vault'}
            onClick={() => handleToggle('user_vault')}
            disabled={toggling}
          >
            Each user provides their own
          </PolicyChip>
        </div>
      </div>

      {toggleErr && (
        <div
          data-testid={`secret-policy-error-${key}`}
          style={{ fontSize: 12, color: '#c2321f', marginBottom: 8 }}
        >
          {toggleErr}
        </div>
      )}

      {policy === 'creator_override' ? (
        <>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginBottom: 10,
              flexWrap: 'wrap',
            }}
          >
            {creatorHasValue ? (
              <span
                data-testid={`creator-secret-status-set-${key}`}
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: 'var(--accent)',
                  background: 'var(--accent-soft)',
                  border: '1px solid var(--accent-border)',
                  padding: '2px 8px',
                  borderRadius: 999,
                }}
              >
                •••• set by you
              </span>
            ) : (
              <span
                data-testid={`creator-secret-status-unset-${key}`}
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: 'var(--muted)',
                  background: 'var(--bg)',
                  border: '1px solid var(--line)',
                  padding: '2px 8px',
                  borderRadius: 999,
                }}
              >
                — no value yet
              </span>
            )}
          </div>

          <form
            onSubmit={handleSaveValue}
            style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}
          >
            <input
              ref={inputRef}
              data-testid={`creator-secret-input-${key}`}
              type="password"
              autoComplete="off"
              placeholder={creatorHasValue ? 'Paste to replace…' : 'Paste value…'}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              style={{
                flex: 1,
                minWidth: 220,
                padding: '8px 12px',
                border: '1px solid var(--line)',
                borderRadius: 8,
                fontSize: 13,
                fontFamily: 'JetBrains Mono, monospace',
                background: 'var(--bg)',
                color: 'var(--ink)',
              }}
            />
            <button
              type="submit"
              data-testid={`creator-secret-save-${key}`}
              disabled={valueStatus !== 'idle' || !value.trim()}
              style={{
                padding: '8px 16px',
                background: 'var(--ink)',
                color: '#fff',
                border: 'none',
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 600,
                cursor:
                  valueStatus === 'idle' && value.trim() ? 'pointer' : 'default',
                opacity: valueStatus !== 'idle' || !value.trim() ? 0.6 : 1,
                fontFamily: 'inherit',
              }}
            >
              {valueStatus === 'saving' ? 'Saving…' : 'Save'}
            </button>
            {creatorHasValue && (
              <button
                type="button"
                data-testid={`creator-secret-remove-${key}`}
                onClick={handleRemoveValue}
                disabled={valueStatus !== 'idle'}
                style={{
                  padding: '8px 14px',
                  background: 'var(--card)',
                  color: '#c2321f',
                  border: '1px solid #f4b7b1',
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: valueStatus === 'idle' ? 'pointer' : 'default',
                  opacity: valueStatus !== 'idle' ? 0.6 : 1,
                  fontFamily: 'inherit',
                }}
              >
                {valueStatus === 'removing' ? 'Removing…' : 'Delete'}
              </button>
            )}
          </form>
          {valueErr && (
            <div
              data-testid={`creator-secret-error-${key}`}
              style={{ fontSize: 12, color: '#c2321f', marginTop: 6 }}
            >
              {valueErr}
            </div>
          )}
        </>
      ) : (
        <div
          data-testid={`secret-policy-user-hint-${key}`}
          style={{
            fontSize: 12,
            color: 'var(--muted)',
            lineHeight: 1.5,
            background: 'var(--bg)',
            border: '1px solid var(--line)',
            borderRadius: 8,
            padding: '10px 12px',
          }}
        >
          {creatorHasValue
            ? 'Users will provide this themselves. Your saved value is kept in case you switch back.'
            : 'Users will set this in their own vault.'}
        </div>
      )}
    </div>
  );
}

function PolicyChip({
  selected,
  onClick,
  disabled,
  children,
  testId,
}: {
  selected: boolean;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  testId: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      data-testid={testId}
      data-selected={selected ? 'true' : 'false'}
      onClick={onClick}
      disabled={disabled}
      style={{
        border: 'none',
        background: selected ? 'var(--ink)' : 'transparent',
        color: selected ? '#fff' : 'var(--ink)',
        fontFamily: 'inherit',
        fontSize: 12,
        fontWeight: 600,
        padding: '5px 12px',
        borderRadius: 999,
        cursor: disabled ? 'default' : 'pointer',
        transition: 'background 120ms ease, color 120ms ease',
      }}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------
// Non-creator vault row (unchanged from pre-secrets-policy behavior).
// ---------------------------------------------------------------------

interface SecretRowProps {
  secretKey: string;
  entry: UserSecretEntry | null;
  onSave: (value: string) => Promise<void>;
  onRemove: () => Promise<void>;
}

function SecretRow({ secretKey, entry, onSave, onRemove }: SecretRowProps) {
  const [value, setValue] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving' | 'removing'>('idle');
  const [err, setErr] = useState<string | null>(null);
  const isSet = !!entry;

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    if (!value.trim()) return;
    setStatus('saving');
    setErr(null);
    try {
      await onSave(value);
      setValue('');
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'Failed to save');
    } finally {
      setStatus('idle');
    }
  }

  async function handleRemove() {
    if (!window.confirm(`Remove ${secretKey}?`)) return;
    setStatus('removing');
    setErr(null);
    try {
      await onRemove();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'Failed to remove');
    } finally {
      setStatus('idle');
    }
  }

  return (
    <div
      data-testid={`secret-row-${secretKey}`}
      style={{
        background: 'var(--card)',
        border: '1px solid var(--line)',
        borderRadius: 10,
        padding: '14px 16px',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          marginBottom: 10,
          flexWrap: 'wrap',
        }}
      >
        <code
          style={{
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--ink)',
          }}
        >
          {secretKey}
        </code>
        {isSet ? (
          <span
            data-testid={`secret-status-set-${secretKey}`}
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--accent)',
              background: 'var(--accent-soft)',
              border: '1px solid var(--accent-border)',
              padding: '2px 8px',
              borderRadius: 999,
            }}
          >
            •••• set
          </span>
        ) : (
          <span
            data-testid={`secret-status-unset-${secretKey}`}
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--muted)',
              background: 'var(--bg)',
              border: '1px solid var(--line)',
              padding: '2px 8px',
              borderRadius: 999,
            }}
          >
            — not set
          </span>
        )}
        {entry?.updated_at && (
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>
            updated {formatTimestamp(entry.updated_at)}
          </span>
        )}
      </div>

      <form onSubmit={handleSave} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input
          data-testid={`secret-input-${secretKey}`}
          type="password"
          autoComplete="off"
          placeholder={isSet ? 'Paste to replace…' : 'Paste value…'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          style={{
            flex: 1,
            minWidth: 220,
            padding: '8px 12px',
            border: '1px solid var(--line)',
            borderRadius: 8,
            fontSize: 13,
            fontFamily: 'JetBrains Mono, monospace',
            background: 'var(--bg)',
            color: 'var(--ink)',
          }}
        />
        <button
          type="submit"
          data-testid={`secret-save-${secretKey}`}
          disabled={status !== 'idle' || !value.trim()}
          style={{
            padding: '8px 16px',
            background: 'var(--ink)',
            color: '#fff',
            border: 'none',
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 600,
            cursor: status === 'idle' && value.trim() ? 'pointer' : 'default',
            opacity: status !== 'idle' || !value.trim() ? 0.6 : 1,
            fontFamily: 'inherit',
          }}
        >
          {status === 'saving' ? 'Saving…' : 'Save'}
        </button>
        {isSet && (
          <button
            type="button"
            data-testid={`secret-remove-${secretKey}`}
            onClick={handleRemove}
            disabled={status !== 'idle'}
            style={{
              padding: '8px 14px',
              background: 'var(--card)',
              color: '#c2321f',
              border: '1px solid #f4b7b1',
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 600,
              cursor: status === 'idle' ? 'pointer' : 'default',
              opacity: status !== 'idle' ? 0.6 : 1,
              fontFamily: 'inherit',
            }}
          >
            {status === 'removing' ? 'Removing…' : 'Delete'}
          </button>
        )}
      </form>

      {err && (
        <div
          data-testid={`secret-error-${secretKey}`}
          style={{ fontSize: 12, color: '#c2321f', marginTop: 6 }}
        >
          {err}
        </div>
      )}
    </div>
  );
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    const now = Date.now();
    const diff = now - d.getTime();
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
