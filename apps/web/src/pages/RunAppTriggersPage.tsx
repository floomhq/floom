// /run/apps/:slug/triggers — workspace-level trigger management for
// an installed app (consumer Run context).
//
// Consumer triggers are scoped to the workspace: each workspace can
// configure its own schedules and webhooks for an app. The creator can
// ship default trigger templates, but those don't fire automatically
// in a workspace without a corresponding trigger configured here.
//
// Data layer reuses the same /api/me/triggers endpoint as the Studio
// triggers tab, filtered to the current slug. Creating / toggling /
// deleting follows the same API calls.

import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import cronstrue from 'cronstrue';
import { WorkspacePageShell } from '../components/WorkspacePageShell';
import { RunAppTabs } from '../components/RunAppTabs';
import { AppIcon } from '../components/AppIcon';
import * as api from '../api/client';
import type { AppDetail } from '../lib/types';
import type { TriggerPublic, CreateTriggerResponse } from '../api/client';

type ModalMode = 'closed' | 'schedule' | 'webhook';

export function RunAppTriggersPage() {
  const { slug } = useParams<{ slug: string }>();
  const nav = useNavigate();
  const [app, setApp] = useState<AppDetail | null>(null);
  const [triggers, setTriggers] = useState<TriggerPublic[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modalMode, setModalMode] = useState<ModalMode>('closed');
  const [createdSecret, setCreatedSecret] = useState<CreateTriggerResponse | null>(null);

  const reload = useCallback(async () => {
    if (!slug) return;
    try {
      const res = await api.listMyTriggers();
      setTriggers(res.triggers.filter((t) => t.app_slug === slug));
    } catch (err) {
      setError((err as Error).message || 'Failed to load triggers');
    }
  }, [slug]);

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
          nav('/run/apps', { replace: true });
          return;
        }
        setError((err as Error).message || 'Failed to load app');
      });
    void reload();
    return () => {
      cancelled = true;
    };
  }, [slug, nav, reload]);

  async function handleToggle(t: TriggerPublic) {
    try {
      await api.updateTrigger(t.id, { enabled: !t.enabled });
      await reload();
    } catch (err) {
      setError((err as Error).message || 'Could not toggle trigger');
    }
  }

  async function handleDelete(t: TriggerPublic) {
    const label =
      t.trigger_type === 'schedule'
        ? `schedule (${t.cron_expression})`
        : `webhook (${t.webhook_url_path})`;
    if (!window.confirm(`Delete this ${label}? This cannot be undone.`)) return;
    try {
      await api.deleteTrigger(t.id);
      await reload();
    } catch (err) {
      setError((err as Error).message || 'Could not delete trigger');
    }
  }

  return (
    <WorkspacePageShell
      mode="run"
      title={app ? `${app.name} · Triggers · Floom` : 'Triggers · Floom'}
    >
      {/* Breadcrumb */}
      <nav
        aria-label="Breadcrumb"
        style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 16 }}
      >
        <Link to="/run/apps" style={{ color: 'var(--muted)', textDecoration: 'none' }}>
          Apps
        </Link>
        <span style={{ margin: '0 6px' }}>›</span>
        {app ? (
          <Link
            to={`/run/apps/${app.slug}/run`}
            style={{ color: 'var(--muted)', textDecoration: 'none' }}
          >
            {app.name}
          </Link>
        ) : (
          <span>{slug}</span>
        )}
        <span style={{ margin: '0 6px' }}>›</span>
        <span style={{ color: 'var(--ink)' }}>Triggers</span>
      </nav>

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

      {!app && !error && (
        <div style={{ fontSize: 13, color: 'var(--muted)' }}>Loading…</div>
      )}

      {app && (
        <>
          {/* App meta strip */}
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 14,
              marginBottom: 20,
            }}
          >
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: 10,
                background:
                  'radial-gradient(circle at 30% 25%, #d1fae5 0%, #ecfdf5 55%, #d1fae5 100%)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                boxShadow:
                  'inset 0 0 0 1px rgba(5,150,105,0.15), 0 1px 2px rgba(5,150,105,0.18), inset 0 1px 0 rgba(255,255,255,0.6)',
              }}
            >
              <AppIcon slug={app.slug} size={22} color="#047857" />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <h1 style={{ fontSize: 20, fontWeight: 700, color: 'var(--ink)', margin: 0 }}>
                {app.name}
              </h1>
              <div
                style={{
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: 11,
                  color: 'var(--muted)',
                  marginTop: 3,
                }}
              >
                {app.slug}
                {app.version ? ` · v${app.version}` : ''}
              </div>
            </div>
          </div>

          {/* Tab strip */}
          <RunAppTabs slug={app.slug} activeTab="triggers" />

          {/* Triggers section header */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
              marginBottom: 20,
              flexWrap: 'wrap',
              gap: 12,
            }}
          >
            <div>
              <h2
                style={{
                  fontSize: 15,
                  fontWeight: 600,
                  color: 'var(--ink)',
                  margin: 0,
                }}
              >
                Triggers for {app.name}
              </h2>
              <p
                style={{
                  margin: '4px 0 0',
                  fontSize: 13,
                  color: 'var(--muted)',
                  lineHeight: 1.55,
                  maxWidth: 600,
                }}
              >
                Triggers run this installed app inside your workspace. Each workspace
                configures its own schedules and webhooks. The app's owner can publish
                defaults, but those don't fire automatically without a trigger here.
              </p>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                onClick={() => setModalMode('schedule')}
                data-testid="run-triggers-new-schedule"
                style={secondaryBtnStyle}
              >
                + Schedule
              </button>
              <button
                type="button"
                onClick={() => setModalMode('webhook')}
                data-testid="run-triggers-new-webhook"
                style={secondaryBtnStyle}
              >
                + Webhook
              </button>
            </div>
          </div>

          {/* Triggers list */}
          {triggers === null && (
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>Loading…</div>
          )}
          {triggers !== null && triggers.length === 0 && (
            <div
              data-testid="run-triggers-empty"
              style={{
                border: '1px dashed var(--line)',
                borderRadius: 10,
                padding: '24px 20px',
                background: 'var(--card)',
              }}
            >
              <div
                style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', marginBottom: 4 }}
              >
                No triggers yet
              </div>
              <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 14px' }}>
                Create one to fire this app on a schedule or from an external webhook.
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  onClick={() => setModalMode('schedule')}
                  style={secondaryBtnStyle}
                >
                  Schedule
                </button>
                <button
                  type="button"
                  onClick={() => setModalMode('webhook')}
                  style={secondaryBtnStyle}
                >
                  Webhook
                </button>
              </div>
            </div>
          )}
          {triggers !== null && triggers.length > 0 && (
            <div
              data-testid="run-triggers-list"
              style={{
                border: '1px solid var(--line)',
                borderRadius: 10,
                background: 'var(--card)',
                overflow: 'hidden',
                marginBottom: 20,
              }}
            >
              {triggers.map((t) => (
                <TriggerRow
                  key={t.id}
                  trigger={t}
                  onToggle={handleToggle}
                  onDelete={handleDelete}
                />
              ))}
            </div>
          )}

          {/* Modal */}
          {modalMode !== 'closed' && (
            <NewTriggerModal
              slug={slug || ''}
              app={app}
              mode={modalMode}
              onModeChange={setModalMode}
              onClose={() => {
                setModalMode('closed');
                setCreatedSecret(null);
              }}
              onCreated={async (res) => {
                if (res.trigger.trigger_type === 'webhook' && res.webhook_secret) {
                  setCreatedSecret(res);
                } else {
                  setModalMode('closed');
                }
                await reload();
              }}
              createdSecret={createdSecret}
            />
          )}
        </>
      )}
    </WorkspacePageShell>
  );
}

// ----- TriggerRow -----

function TriggerRow({
  trigger,
  onToggle,
  onDelete,
}: {
  trigger: TriggerPublic;
  onToggle: (t: TriggerPublic) => void;
  onDelete: (t: TriggerPublic) => void;
}) {
  const isSchedule = trigger.trigger_type === 'schedule';
  let humanCron = '';
  if (isSchedule && trigger.cron_expression) {
    try {
      humanCron = cronstrue.toString(trigger.cron_expression);
    } catch {
      humanCron = 'unparseable cron';
    }
  }
  return (
    <div
      data-testid={`run-trigger-row-${trigger.id}`}
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr auto',
        gap: 16,
        padding: '14px 16px',
        borderBottom: '1px solid var(--line)',
        alignItems: 'center',
      }}
    >
      <div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              textTransform: 'uppercase' as const,
              letterSpacing: '0.04em',
              padding: '2px 8px',
              borderRadius: 999,
              background: isSchedule ? '#e0e7ff' : '#fef3c7',
              color: isSchedule ? '#3730a3' : '#b45309',
            }}
          >
            {isSchedule ? 'Schedule' : 'Webhook'}
          </span>
          <code
            style={{
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 12,
              color: 'var(--ink)',
            }}
          >
            {trigger.action}
          </code>
          {!trigger.enabled && (
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                padding: '2px 8px',
                borderRadius: 999,
                background: '#f4f4f2',
                color: 'var(--muted)',
              }}
            >
              Disabled
            </span>
          )}
        </div>
        {isSchedule && (
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            <code style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              {trigger.cron_expression}
            </code>{' '}
            ({trigger.tz || 'UTC'}) · {humanCron}
          </div>
        )}
        {!isSchedule && trigger.webhook_url_path && (
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            <code style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              /hook/{trigger.webhook_url_path}
            </code>
          </div>
        )}
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
          Last fired:{' '}
          {trigger.last_fired_at
            ? new Date(trigger.last_fired_at).toISOString()
            : 'never'}
          {isSchedule && trigger.next_run_at && (
            <> · Next: {new Date(trigger.next_run_at).toISOString()}</>
          )}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          onClick={() => onToggle(trigger)}
          data-testid={`run-trigger-toggle-${trigger.id}`}
          style={smallBtnStyle}
        >
          {trigger.enabled ? 'Disable' : 'Enable'}
        </button>
        <button
          type="button"
          onClick={() => onDelete(trigger)}
          data-testid={`run-trigger-delete-${trigger.id}`}
          style={{ ...smallBtnStyle, color: '#c2321f', borderColor: '#c2321f' }}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

// ----- NewTriggerModal (same shape as StudioTriggersTab's modal) -----

function NewTriggerModal({
  slug,
  app,
  mode,
  onModeChange,
  onClose,
  onCreated,
  createdSecret,
}: {
  slug: string;
  app: AppDetail;
  mode: ModalMode;
  onModeChange: (m: ModalMode) => void;
  onClose: () => void;
  onCreated: (res: CreateTriggerResponse) => void;
  createdSecret: CreateTriggerResponse | null;
}) {
  const actions = Object.keys(app.manifest.actions);
  const defaultAction = app.manifest.primary_action || actions[0] || 'run';
  const [action, setAction] = useState(defaultAction);
  const [cron, setCron] = useState('0 9 * * 1');
  const [tz, setTz] = useState('UTC');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  let cronPreview = '';
  try {
    cronPreview = cronstrue.toString(cron);
  } catch (e) {
    cronPreview = (e as Error).message;
  }

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const res =
        mode === 'schedule'
          ? await api.createScheduleTrigger(slug, { action, cron_expression: cron, tz })
          : await api.createWebhookTrigger(slug, { action });
      onCreated(res);
    } catch (e) {
      setErr((e as Error).message || 'Could not create trigger');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      data-testid="run-triggers-modal"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
      onClick={() => !busy && onClose()}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--card)',
          borderRadius: 12,
          padding: 24,
          maxWidth: 560,
          width: '100%',
        }}
      >
        {!createdSecret && (
          <>
            <h3 style={{ margin: '0 0 16px', fontSize: 16, color: 'var(--ink)' }}>
              New trigger
            </h3>
            <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
              <button
                type="button"
                onClick={() => onModeChange('schedule')}
                style={modalTabStyle(mode === 'schedule')}
                data-testid="run-triggers-tab-schedule"
              >
                Schedule
              </button>
              <button
                type="button"
                onClick={() => onModeChange('webhook')}
                style={modalTabStyle(mode === 'webhook')}
                data-testid="run-triggers-tab-webhook"
              >
                Webhook
              </button>
            </div>

            <label style={labelStyle}>Action</label>
            <select
              value={action}
              onChange={(e) => setAction(e.target.value)}
              style={inputStyle}
              data-testid="run-triggers-action"
            >
              {actions.map((a) => (
                <option key={a} value={a}>
                  {app.manifest.actions[a]?.label || a}
                </option>
              ))}
            </select>

            {mode === 'schedule' && (
              <>
                <label style={labelStyle}>Cron expression</label>
                <input
                  type="text"
                  value={cron}
                  onChange={(e) => setCron(e.target.value)}
                  placeholder="0 9 * * 1"
                  style={{ ...inputStyle, fontFamily: 'JetBrains Mono, monospace' }}
                  data-testid="run-triggers-cron"
                />
                <p style={{ fontSize: 12, color: 'var(--muted)', margin: '6px 0 14px' }}>
                  {cronPreview}
                </p>
                <label style={labelStyle}>Timezone</label>
                <input
                  type="text"
                  value={tz}
                  onChange={(e) => setTz(e.target.value)}
                  placeholder="UTC"
                  style={inputStyle}
                  data-testid="run-triggers-tz"
                />
                <p style={{ fontSize: 11, color: 'var(--muted)', margin: '6px 0 14px' }}>
                  Any IANA zone, e.g. <code>Europe/Berlin</code>, <code>America/New_York</code>.
                </p>
              </>
            )}

            {mode === 'webhook' && (
              <p style={{ fontSize: 12, color: 'var(--muted)', margin: '6px 0 14px' }}>
                We will mint a public URL and an HMAC secret. The secret is shown
                exactly once. POST with{' '}
                <code>X-Floom-Signature: sha256=&lt;hex&gt;</code>.
              </p>
            )}

            {err && (
              <div
                style={{ fontSize: 12, color: '#c2321f', marginTop: 10 }}
                data-testid="run-triggers-form-error"
              >
                {err}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
              <button type="button" onClick={onClose} disabled={busy} style={secondaryBtnStyle}>
                Cancel
              </button>
              <button
                type="button"
                onClick={() => { void submit(); }}
                disabled={busy}
                data-testid="run-triggers-submit"
                style={primaryBtnStyle}
              >
                {busy ? 'Creating…' : 'Create trigger'}
              </button>
            </div>
          </>
        )}

        {createdSecret && createdSecret.webhook_secret && (
          <>
            <h3 style={{ margin: '0 0 8px', fontSize: 16, color: 'var(--ink)' }}>
              Webhook ready
            </h3>
            <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
              Copy the URL and the secret now. The secret is never shown again.
            </p>
            <label style={labelStyle}>URL</label>
            <CopyField value={createdSecret.webhook_url || ''} testId="run-triggers-created-url" />
            <label style={{ ...labelStyle, marginTop: 14 }}>Secret</label>
            <CopyField value={createdSecret.webhook_secret} testId="run-triggers-created-secret" />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
              <button type="button" onClick={onClose} style={primaryBtnStyle}>Done</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function CopyField({ value, testId }: { value: string; testId?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // best-effort
    }
  }
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      <input
        readOnly
        value={value}
        data-testid={testId}
        style={{
          flex: 1,
          padding: '9px 10px',
          border: '1px solid var(--line)',
          borderRadius: 6,
          fontSize: 12,
          fontFamily: 'JetBrains Mono, monospace',
          background: 'var(--bg)',
        }}
        onFocus={(e) => e.currentTarget.select()}
      />
      <button type="button" onClick={() => { void copy(); }} style={smallBtnStyle}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

// ----- Styles -----

import type { CSSProperties } from 'react';

const smallBtnStyle: CSSProperties = {
  padding: '6px 12px',
  background: 'var(--card)',
  color: 'var(--ink)',
  border: '1px solid var(--line)',
  borderRadius: 6,
  fontSize: 12,
  fontWeight: 500,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const secondaryBtnStyle: CSSProperties = {
  padding: '9px 14px',
  background: 'var(--card)',
  color: 'var(--ink)',
  border: '1px solid var(--line)',
  borderRadius: 8,
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const primaryBtnStyle: CSSProperties = {
  padding: '9px 16px',
  background: 'var(--ink)',
  color: '#fff',
  border: 'none',
  borderRadius: 8,
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const labelStyle: CSSProperties = {
  display: 'block',
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--ink)',
  marginBottom: 6,
};

const inputStyle: CSSProperties = {
  display: 'block',
  width: '100%',
  padding: '10px 12px',
  border: '1px solid var(--line)',
  borderRadius: 8,
  fontSize: 13,
  color: 'var(--ink)',
  background: 'var(--card)',
  fontFamily: 'inherit',
  boxSizing: 'border-box',
  marginBottom: 12,
};

function modalTabStyle(active: boolean): CSSProperties {
  return {
    flex: 1,
    padding: '9px 12px',
    background: active ? 'var(--ink)' : 'var(--card)',
    color: active ? '#fff' : 'var(--ink)',
    border: '1px solid ' + (active ? 'var(--ink)' : 'var(--line)'),
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  };
}
