// Shared helper for "what secrets does this app actually need?".
//
// Pre-fix (2026-04-20), the run preflight (MeAppRunPage) and the
// App creator secrets page (MeAppSecretsPage / StudioAppSecretsPage) both read
// `manifest.secrets_needed` and nothing else. For OpenAPI-ingested
// apps the ingest pipeline can populate **per-action** `secrets_needed`
// (via the operation's effective `security` block) while leaving the
// manifest-level list empty or partial. That produced a cross-surface
// dead end described in:
//
//   docs/ux-audit/by-route/route-12-me-app-run.md  (R12-2)
//   docs/ux-audit/by-route/route-18-studio-app-secrets.md  (§5)
//   docs/ux-audit/LAUNCH-UX-AUDIT-2026-04-20.md   (C1, M1)
//
// Symptom: the runner returns `auth_error` with copy pointing the
// owner at Studio → App creator secrets, but the page sees an empty
// `secrets_needed` and says "this app doesn't declare any secrets."
// Owner is stuck between two screens contradicting each other.
//
// Fix: always compute the required-key set as the **union** of the
// manifest-level list and every action's per-action list. This is
// the single source of truth both pages should consult.

import type { NormalizedManifest } from './types';

/**
 * Deduped union of manifest-level + per-action `secrets_needed` for
 * the given manifest. Preserves insertion order (manifest-level
 * first, then action-by-action). Stable across calls — callers can
 * pass it directly into React keys if needed.
 */
export function collectRequiredSecretKeys(
  manifest: NormalizedManifest | null | undefined,
): string[] {
  if (!manifest) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (key: string) => {
    const trimmed = typeof key === 'string' ? key.trim() : '';
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push(trimmed);
  };
  for (const key of manifest.secrets_needed ?? []) push(key);
  const actions = manifest.actions ?? {};
  for (const action of Object.values(actions)) {
    for (const key of action.secrets_needed ?? []) push(key);
  }
  return out;
}
