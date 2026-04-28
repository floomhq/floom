// /studio/:slug/access — v1 sharing + rate limit.
//
// v1 scope (issues #921, #923):
//   - Visibility: "Only me" (private) | "Public" — 2 options only
//   - Global rate limit: number + unit (req/min, req/hour, req/day)
//
// v1.1 deferred (DO NOT render):
//   - "Selected" / per-workspace-member visibility
//   - Per-member rate limit
//   - Per-caller rate limit
//
// API wiring:
//   - Visibility → PATCH /api/hub/:slug via api.updateAppVisibility (exists)
//   - Rate limit  → TODO: no backend endpoint yet; local state only

import { useEffect, useState } from 'react';
import type { ChangeEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { StudioLayout } from '../components/studio/StudioLayout';
import { AppHeader } from './MeAppPage';
import * as api from '../api/client';
import type { AppDetail } from '../lib/types';

type Visibility = 'private' | 'public';
type RateLimitUnit = 'req/min' | 'req/hour' | 'req/day';

export function StudioAppAccessPage() {
  const { slug } = useParams<{ slug: string }>();
  const nav = useNavigate();

  const [app, setApp] = useState<AppDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Visibility form state
  const [visibility, setVisibility] = useState<Visibility>('private');
  const [visibilitySaving, setVisibilitySaving] = useState(false);

  // Rate limit form state — local only (TODO: wire to API)
  const [rateLimitEnabled, setRateLimitEnabled] = useState(false);
  const [rateLimitValue, setRateLimitValue] = useState<string>('1000');
  const [rateLimitUnit, setRateLimitUnit] = useState<RateLimitUnit>('req/day');
  const [rateLimitSaving, setRateLimitSaving] = useState(false);

  // Per-section feedback
  const [visibilityNotice, setVisibilityNotice] = useState<string | null>(null);
  const [visibilityError, setVisibilityError] = useState<string | null>(null);
  const [rateLimitNotice, setRateLimitNotice] = useState<string | null>(null);
  const [rateLimitError, setRateLimitError] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    api
      .getApp(slug)
      .then((res) => {
        if (cancelled) return;
        setApp(res);
        // Map server visibility to the v1 binary.
        // "auth-required" is treated as "public" in the v1 UI since the
        // distinction ships in v1.1. Creators who had auth-required set will
        // see "Public" selected here; saving will replace it with "public".
        const raw = (res as AppDetail & { visibility?: string }).visibility;
        setVisibility(raw === 'private' ? 'private' : 'public');
      })
      .catch((err) => {
        if (cancelled) return;
        const status = (err as { status?: number }).status;
        if (status === 404) return nav('/studio', { replace: true });
        if (status === 403) return nav(`/p/${slug}`, { replace: true });
        setLoadError((err as Error).message || 'Failed to load app');
      });
    return () => {
      cancelled = true;
    };
  }, [slug, nav]);

  async function handleVisibilitySave() {
    if (!slug) return;
    setVisibilitySaving(true);
    setVisibilityError(null);
    setVisibilityNotice(null);
    try {
      await api.updateAppVisibility(slug, visibility);
      setVisibilityNotice('Visibility saved.');
    } catch (err) {
      setVisibilityError((err as Error).message || 'Failed to save visibility');
    } finally {
      setVisibilitySaving(false);
    }
  }

  function handleRateLimitSave() {
    // TODO: wire to backend endpoint once API ships (v1 deferred to backend).
    // For now, persist locally and surface a confirmation.
    setRateLimitSaving(true);
    setRateLimitError(null);
    setRateLimitNotice(null);
    setTimeout(() => {
      setRateLimitSaving(false);
      setRateLimitNotice('Rate limit saved locally. (Backend endpoint pending.)');
    }, 300);
  }

  const rateLimitNum = parseInt(rateLimitValue, 10);
  const rateLimitValid = !rateLimitEnabled || (!isNaN(rateLimitNum) && rateLimitNum > 0);

  return (
    <StudioLayout
      title={app ? `${app.name} · Access · Studio` : 'Access · Studio'}
      activeAppSlug={slug}
      activeSubsection="access"
    >
      {loadError && (
        <div style={styles.errorBanner} data-testid="studio-access-load-error">
          {loadError}
        </div>
      )}

      {!app && !loadError && <LoadingSkeleton />}

      {app && (
        <div data-testid="studio-access-page">
          <AppHeader app={app} />

          {/* ── Visibility ─────────────────────────────────────────────── */}
          <section
            data-testid="studio-access-visibility-section"
            style={styles.section}
          >
            <h2 style={styles.sectionTitle}>Visibility</h2>
            <p style={styles.sectionDesc}>
              Pick who can discover and run this app from the Store.
            </p>

            <div
              role="radiogroup"
              aria-label="App visibility"
              style={styles.radioGroup}
            >
              <VisibilityCard
                value="private"
                current={visibility}
                onChange={setVisibility}
                label="Only me"
                description="Not listed in the Store. Only your signed-in session can open and run it."
                testId="studio-access-visibility-private"
              />
              <VisibilityCard
                value="public"
                current={visibility}
                onChange={setVisibility}
                label="Public"
                description="Appears in the Store. Anyone can find and run this app."
                testId="studio-access-visibility-public"
              />
            </div>

            {visibilityNotice && (
              <div style={styles.noticeBanner} data-testid="studio-access-visibility-notice">
                {visibilityNotice}
              </div>
            )}
            {visibilityError && (
              <div style={styles.errorBanner} data-testid="studio-access-visibility-error">
                {visibilityError}
              </div>
            )}

            <div style={styles.saveRow}>
              <button
                type="button"
                onClick={handleVisibilitySave}
                disabled={visibilitySaving}
                data-testid="studio-access-visibility-save"
                style={visibilitySaving ? { ...styles.saveBtn, opacity: 0.6, cursor: 'wait' } : styles.saveBtn}
              >
                {visibilitySaving ? 'Saving…' : 'Save visibility'}
              </button>
            </div>
          </section>

          {/* ── Rate limit ─────────────────────────────────────────────── */}
          <section
            data-testid="studio-access-rate-limit-section"
            style={styles.section}
          >
            <h2 style={styles.sectionTitle}>Rate limit</h2>
            <p style={styles.sectionDesc}>
              Limit how often callers can trigger this app. Applies to all
              callers regardless of identity.
            </p>

            <div style={{ marginBottom: 14 }}>
              <label style={styles.checkRow}>
                <input
                  type="checkbox"
                  checked={rateLimitEnabled}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    setRateLimitEnabled(e.target.checked);
                    setRateLimitNotice(null);
                    setRateLimitError(null);
                  }}
                  data-testid="studio-access-rate-limit-toggle"
                  style={{ accentColor: 'var(--accent)', margin: 0, cursor: 'pointer' }}
                />
                <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>
                  Enable global rate limit
                </span>
              </label>
            </div>

            {rateLimitEnabled && (
              <div style={styles.rateLimitInputRow}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <label
                    htmlFor="studio-access-rate-limit-value"
                    style={styles.inputLabel}
                  >
                    Global rate limit
                  </label>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <input
                      id="studio-access-rate-limit-value"
                      type="number"
                      min={1}
                      value={rateLimitValue}
                      onChange={(e: ChangeEvent<HTMLInputElement>) =>
                        setRateLimitValue(e.target.value)
                      }
                      data-testid="studio-access-rate-limit-value"
                      style={styles.numberInput}
                      placeholder="e.g. 1000"
                    />
                    <select
                      value={rateLimitUnit}
                      onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                        setRateLimitUnit(e.target.value as RateLimitUnit)
                      }
                      data-testid="studio-access-rate-limit-unit"
                      style={styles.unitSelect}
                      aria-label="Rate limit unit"
                    >
                      <option value="req/min">req / min</option>
                      <option value="req/hour">req / hour</option>
                      <option value="req/day">req / day</option>
                    </select>
                  </div>
                  <p style={styles.inputHint}>
                    Applies to all callers regardless of identity.
                  </p>
                </div>
              </div>
            )}

            {rateLimitNotice && (
              <div style={styles.noticeBanner} data-testid="studio-access-rate-limit-notice">
                {rateLimitNotice}
              </div>
            )}
            {rateLimitError && (
              <div style={styles.errorBanner} data-testid="studio-access-rate-limit-error">
                {rateLimitError}
              </div>
            )}

            <div style={styles.saveRow}>
              <button
                type="button"
                onClick={handleRateLimitSave}
                disabled={rateLimitSaving || !rateLimitValid}
                data-testid="studio-access-rate-limit-save"
                style={
                  rateLimitSaving || !rateLimitValid
                    ? { ...styles.saveBtn, opacity: 0.6, cursor: rateLimitSaving ? 'wait' : 'default' }
                    : styles.saveBtn
                }
              >
                {rateLimitSaving ? 'Saving…' : 'Save rate limit'}
              </button>
            </div>
          </section>
        </div>
      )}
    </StudioLayout>
  );
}

// ── Subcomponents ────────────────────────────────────────────────────────────

function VisibilityCard({
  value,
  current,
  onChange,
  label,
  description,
  testId,
}: {
  value: Visibility;
  current: Visibility;
  onChange: (v: Visibility) => void;
  label: string;
  description: string;
  testId: string;
}) {
  const selected = value === current;
  return (
    <label
      data-testid={testId}
      data-selected={selected ? 'true' : 'false'}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        padding: '14px 16px',
        borderRadius: 12,
        border: selected ? '1.5px solid var(--accent)' : '1px solid var(--line)',
        background: selected ? 'var(--accent-soft, #e6f4ea)' : 'var(--card)',
        cursor: 'pointer',
        transition: 'border-color 120ms, background 120ms',
      }}
    >
      <input
        type="radio"
        name="studio-access-visibility"
        value={value}
        checked={selected}
        onChange={() => onChange(value)}
        data-testid={`${testId}-radio`}
        style={{ accentColor: 'var(--accent)', margin: '2px 0 0', flexShrink: 0 }}
      />
      <div>
        <div
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: selected ? 'var(--accent)' : 'var(--ink)',
            marginBottom: 3,
          }}
        >
          {label}
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.55 }}>
          {description}
        </div>
      </div>
    </label>
  );
}

function LoadingSkeleton() {
  return (
    <div data-testid="studio-access-loading" style={{ opacity: 0.6 }}>
      <div style={{ height: 44, background: 'var(--bg)', borderRadius: 8, marginBottom: 16 }} />
      <div style={{ height: 180, background: 'var(--bg)', borderRadius: 12, marginBottom: 16 }} />
      <div style={{ height: 140, background: 'var(--bg)', borderRadius: 12 }} />
    </div>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const styles = {
  section: {
    background: 'var(--card)',
    border: '1px solid var(--line)',
    borderRadius: 12,
    padding: '20px 22px',
    marginBottom: 16,
    boxShadow: 'var(--shadow-1, none)',
  } as React.CSSProperties,

  sectionTitle: {
    fontSize: 14,
    fontWeight: 700,
    color: 'var(--ink)',
    margin: '0 0 4px',
  } as React.CSSProperties,

  sectionDesc: {
    fontSize: 12,
    color: 'var(--muted)',
    margin: '0 0 16px',
    lineHeight: 1.55,
    maxWidth: 600,
  } as React.CSSProperties,

  radioGroup: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
    gap: 10,
    marginBottom: 16,
  } as React.CSSProperties,

  saveRow: {
    marginTop: 16,
    display: 'flex',
    gap: 10,
    flexWrap: 'wrap' as const,
  } as React.CSSProperties,

  saveBtn: {
    padding: '9px 20px',
    background: '#047857',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  } as React.CSSProperties,

  noticeBanner: {
    background: '#d7f1e0',
    border: '1px solid #a5d9b7',
    color: '#1f6a3a',
    padding: '9px 14px',
    borderRadius: 8,
    fontSize: 13,
    marginTop: 10,
  } as React.CSSProperties,

  errorBanner: {
    background: '#fdecea',
    border: '1px solid #f4b7b1',
    color: '#c2321f',
    padding: '9px 14px',
    borderRadius: 8,
    fontSize: 13,
    marginTop: 10,
  } as React.CSSProperties,

  checkRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    cursor: 'pointer',
  } as React.CSSProperties,

  rateLimitInputRow: {
    marginBottom: 8,
  } as React.CSSProperties,

  inputLabel: {
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--ink)',
    marginBottom: 4,
  } as React.CSSProperties,

  numberInput: {
    width: 100,
    padding: '9px 12px',
    border: '1px solid var(--line)',
    borderRadius: 8,
    fontSize: 14,
    color: 'var(--ink)',
    background: 'var(--card)',
    fontFamily: 'JetBrains Mono, monospace',
  } as React.CSSProperties,

  unitSelect: {
    padding: '9px 12px',
    border: '1px solid var(--line)',
    borderRadius: 8,
    fontSize: 13,
    color: 'var(--ink)',
    background: 'var(--card)',
    fontFamily: 'inherit',
    cursor: 'pointer',
  } as React.CSSProperties,

  inputHint: {
    fontSize: 11,
    color: 'var(--muted)',
    margin: '4px 0 0',
    lineHeight: 1.5,
  } as React.CSSProperties,
} as const;
