# Launch Blocker Audit - 2026-04-27

Scope: Track C re-verification for OAuth, Resend, migration dry-run scope, and remaining launch blockers.

## Current Launch Status

| Area | Status | Evidence |
| --- | --- | --- |
| Google OAuth | PASS | Playwright drove Better Auth social start; redirect host was `accounts.google.com`; callback was `https://preview.floom.dev/auth/callback/google`; Google rendered the sign-in page with no redirect URI mismatch |
| GitHub OAuth | DEFERRED | Preview container has empty `GITHUB_OAUTH_CLIENT_ID` and `GITHUB_OAUTH_CLIENT_SECRET`; route returns `GitHub auth not configured` without crashing |
| Resend delivery | PASS | Real Resend message IDs captured for signup confirmation, password reset, and app invite |
| Migration dry-run | PASS for v1 | Federico clarified v1 is single-user-per-workspace; synthetic multi-user conflict assertion is v1.1 scope |
| Remaining Federico-only gate | OPEN | Actual production deploy and post-deploy smoke |

## Top Remaining Items for Federico

1. Provision GitHub OAuth credentials if GitHub sign-in is part of launch.
2. Run actual production deploy.
3. Run post-deploy smoke on production after deploy.

## OAuth Verification

Google: **PASS**.

- Server built with `npx tsc -p .`.
- Server restarted on port `3051` with live preview Google credentials from `floom-preview-launch`.
- `/api/session/me` returned `cloud_mode=true`, `auth_providers.google=true`, `auth_providers.github=false`, and `deploy_enabled=true`.
- Better Auth social start is `POST /auth/sign-in/social`.
- Google start returned HTTP `200`.
- Captured provider host: `accounts.google.com`.
- Captured callback URL: `https://preview.floom.dev/auth/callback/google`.
- Playwright screenshot: `/tmp/floom-track-c/oauth/google-provider-page.png`.
- Raw capture: `/tmp/floom-track-c/oauth-results.json`.

GitHub: **DEFERRED**.

- `GITHUB_OAUTH_CLIENT_ID` is empty in the live preview container.
- `GITHUB_OAUTH_CLIENT_SECRET` is empty in the live preview container.
- `/api/session/me.auth_providers.github=false`.
- `POST /auth/sign-in/social` with `provider=github` returns:

```json
{
  "error": "GitHub auth not configured",
  "code": "provider_not_configured",
  "provider": "github"
}
```

Federico needs to create a GitHub OAuth app, configure `https://preview.floom.dev/auth/callback/github` and `https://floom.dev/auth/callback/github`, set the two GitHub env vars, restart, and re-run the same start-route check.

## Resend Verification

Resend: **PASS**.

Only this recipient was used:

```text
depontefede+floom-test@gmail.com
```

Captured real Resend provider IDs:

| Kind | Message id |
| --- | --- |
| `SIGNUP_CONFIRMATION` | `69bc2cce-09e9-4e49-ba6c-36ed656b3362` |
| `PASSWORD_RESET` | `627dbfed-a51e-4533-9b75-eefbb9080df7` |
| `APP_INVITE` | `8437c5bf-8904-41d5-a316-44437bb140e1` |

Workspace-member invite email is not implemented yet. The workspace invite route returns an invite plus `accept_url`; it does not call `sendEmail()`.

Raw capture: `/tmp/floom-track-c/email-results.json`.

## Migration Verification

Migration: **PASS for v1**.

The earlier strict conflict failure came from synthetic multi-user-per-workspace data. Federico clarified that this is not a v1 scenario. For v1, each workspace has one user, so the conflict-resolution assertion is out of scope and moves to v1.1.

Still-real bug:

- Rollback by dropping `workspace_secrets` breaks workspace-secret readers with `no such table: workspace_secrets`.
- Keep the rollback fix recommendation: leave the table present but empty during rollback, or add table-missing fallback in workspace-secret readers.

Details: `docs/MIGRATION-DRY-RUN.md`.

## Verification Commands Run

```bash
npx tsc -p .
pnpm --filter @floom/server typecheck
pnpm --filter @floom/web typecheck
```

## Final Gate

Code and preview-provider verification are no longer blocking Track C. The only remaining launch blockers are Federico-controlled production deployment and post-deploy smoke verification on the real production URL.
