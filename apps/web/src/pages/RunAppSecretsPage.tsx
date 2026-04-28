// /run/apps/:slug/secrets — consumer view of the secrets contract for
// an installed app in the v26 workspace shell.
//
// Two sections per spec §8:
//   1. "App's required BYOK keys" — which workspace BYOK keys this app
//      expects, with present/missing status + link to /settings/byok-keys.
//   2. "App creator secrets" — read-only list of per-key policies declared
//      by the creator (keys the creator provides vs. keys each user provides).
//
// TODO: backend wire required_workspace_byok manifest field. The type
// stub below will be populated once the server emits the field in the
// manifest response.

import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { WorkspacePageShell } from '../components/WorkspacePageShell';
import { RunAppTabs } from '../components/RunAppTabs';
import { AppIcon } from '../components/AppIcon';
import { useSecrets } from '../hooks/useSecrets';
import * as api from '../api/client';
import type { AppDetail, SecretPolicyEntry } from '../lib/types';
import { collectRequiredSecretKeys } from '../lib/manifest-secrets';

export function RunAppSecretsPage() {
  const { slug } = useParams<{ slug: string }>();
  const nav = useNavigate();
  const [app, setApp] = useState<AppDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [policies, setPolicies] = useState<SecretPolicyEntry[] | null>(null);
  const secrets = useSecrets();

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
    return () => {
      cancelled = true;
    };
  }, [slug, nav]);

  useEffect(() => {
    if (!slug || !app) return;
    let cancelled = false;
    api
      .getSecretPolicies(slug)
      .then((res) => {
        if (!cancelled) setPolicies(res.policies);
      })
      .catch(() => {
        if (!cancelled) setPolicies([]);
      });
    return () => {
      cancelled = true;
    };
  }, [slug, app]);

  // All secret keys declared in the manifest (creator-side).
  const neededKeys = collectRequiredSecretKeys(app?.manifest);

  // TODO: backend wire required_workspace_byok manifest field.
  // Once the server emits this field in NormalizedManifest, replace the
  // stub below with:
  //   const requiredByok: string[] = app?.manifest.required_workspace_byok ?? [];
  const requiredByok: string[] = [];

  // Set of workspace BYOK keys the user has configured.
  const userSecretKeys = new Set(secrets.entries?.map((s) => s.key) ?? []);

  // Resolve each neededKey to its policy.
  const policyByKey = new Map<string, SecretPolicyEntry>(
    (policies ?? []).map((p) => [p.key, p]),
  );

  return (
    <WorkspacePageShell
      mode="run"
      title={app ? `${app.name} · Secrets · Floom` : 'Secrets · Floom'}
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
        <span style={{ color: 'var(--ink)' }}>Secrets</span>
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
          <RunAppTabs slug={app.slug} activeTab="secrets" />

          {/* ---- Section 1: Workspace BYOK requirements ---- */}
          <section style={{ marginBottom: 32 }}>
            <h2
              style={{
                fontSize: 15,
                fontWeight: 700,
                color: 'var(--ink)',
                margin: '0 0 4px',
              }}
            >
              Workspace BYOK requirements
            </h2>
            <p
              style={{
                fontSize: 13,
                color: 'var(--muted)',
                margin: '0 0 16px',
                lineHeight: 1.55,
              }}
            >
              BYOK keys this app expects from your workspace. Set these in{' '}
              <Link to="/settings/byok-keys" style={{ color: 'var(--accent)' }}>
                workspace settings
              </Link>
              .
            </p>

            {/* TODO: backend wire required_workspace_byok manifest field.
                Remove this note once the field is emitted by the server. */}
            {requiredByok.length === 0 && (
              <div
                data-testid="run-app-secrets-byok-empty"
                style={{
                  border: '1px dashed var(--line)',
                  borderRadius: 10,
                  padding: '20px 16px',
                  background: 'var(--card)',
                  fontSize: 13,
                  color: 'var(--muted)',
                }}
              >
                No workspace BYOK keys declared by this app.
              </div>
            )}

            {requiredByok.length > 0 && (
              <div
                data-testid="run-app-secrets-byok-list"
                style={{
                  border: '1px solid var(--line)',
                  borderRadius: 10,
                  background: 'var(--card)',
                  overflow: 'hidden',
                }}
              >
                {requiredByok.map((keyName) => {
                  const present = userSecretKeys.has(keyName);
                  return (
                    <div
                      key={keyName}
                      data-testid={`run-byok-row-${keyName}`}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        padding: '12px 16px',
                        borderBottom: '1px solid var(--line)',
                        flexWrap: 'wrap',
                      }}
                    >
                      <code
                        style={{
                          fontFamily: 'JetBrains Mono, monospace',
                          fontSize: 13,
                          fontWeight: 600,
                          color: 'var(--ink)',
                          flex: 1,
                          minWidth: 0,
                        }}
                      >
                        {keyName}
                      </code>
                      {present ? (
                        <span
                          data-testid={`run-byok-present-${keyName}`}
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
                          Present
                        </span>
                      ) : (
                        <>
                          <span
                            data-testid={`run-byok-missing-${keyName}`}
                            style={{
                              fontSize: 11,
                              fontWeight: 600,
                              color: '#b45309',
                              background: '#fef3c7',
                              border: '1px solid #fcd9a8',
                              padding: '2px 8px',
                              borderRadius: 999,
                            }}
                          >
                            Missing
                          </span>
                          <Link
                            to="/settings/byok-keys"
                            style={{
                              fontSize: 12,
                              color: 'var(--accent)',
                              textDecoration: 'none',
                            }}
                          >
                            Add to workspace →
                          </Link>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* ---- Section 2: App creator secrets ---- */}
          <section>
            <h2
              style={{
                fontSize: 15,
                fontWeight: 700,
                color: 'var(--ink)',
                margin: '0 0 4px',
              }}
            >
              App creator secrets
            </h2>
            <p
              style={{
                fontSize: 13,
                color: 'var(--muted)',
                margin: '0 0 16px',
                lineHeight: 1.55,
              }}
            >
              Per-key policies set by the app creator. Keys marked "Creator provides"
              are handled by the creator; you don't need to supply them.
            </p>

            {neededKeys.length === 0 ? (
              <div
                data-testid="run-app-secrets-creator-empty"
                style={{
                  border: '1px dashed var(--line)',
                  borderRadius: 10,
                  padding: '20px 16px',
                  background: 'var(--card)',
                  fontSize: 13,
                  color: 'var(--muted)',
                }}
              >
                This app doesn't declare any secrets.
              </div>
            ) : policies === null ? (
              <div style={{ fontSize: 13, color: 'var(--muted)' }}>Loading…</div>
            ) : (
              <div
                data-testid="run-app-secrets-creator-list"
                style={{
                  border: '1px solid var(--line)',
                  borderRadius: 10,
                  background: 'var(--card)',
                  overflow: 'hidden',
                }}
              >
                {neededKeys.map((keyName) => {
                  const p = policyByKey.get(keyName);
                  const isCreatorProvided = p?.policy === 'creator_override';
                  return (
                    <div
                      key={keyName}
                      data-testid={`run-creator-secret-row-${keyName}`}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        padding: '12px 16px',
                        borderBottom: '1px solid var(--line)',
                        flexWrap: 'wrap',
                      }}
                    >
                      <code
                        style={{
                          fontFamily: 'JetBrains Mono, monospace',
                          fontSize: 13,
                          fontWeight: 600,
                          color: 'var(--ink)',
                          flex: 1,
                          minWidth: 0,
                        }}
                      >
                        {keyName}
                      </code>
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 600,
                          padding: '2px 8px',
                          borderRadius: 999,
                          background: isCreatorProvided
                            ? 'var(--accent-soft)'
                            : 'var(--bg)',
                          color: isCreatorProvided
                            ? 'var(--accent)'
                            : 'var(--muted)',
                          border: `1px solid ${isCreatorProvided ? 'var(--accent-border)' : 'var(--line)'}`,
                        }}
                      >
                        {isCreatorProvided ? 'Creator provides' : 'You provide'}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}
    </WorkspacePageShell>
  );
}
