# OAuth Verification

Date: 2026-04-27

Verdict: **PASS for Google OAuth start and provider-side callback configuration on preview. GitHub is deferred because credentials are empty.**

Raw capture: `/tmp/floom-track-c/oauth-results.json`

Screenshot evidence: `/tmp/floom-track-c/oauth/google-provider-page.png`

## Server Under Test

- Built from `/root/floom/apps/server` with `npx tsc -p .`.
- Restarted on port `3051` in `tmux` session `floom-track-c`.
- Runtime data directory: `/tmp/floom-track-c-data`, so no production data was changed.
- Runtime public origin: `https://preview.floom.dev`.
- Credential source: live `floom-preview-launch` container environment.
- `DEPLOY_ENABLED=true`.

`/api/session/me` verification:

```json
{
  "cloud_mode": true,
  "auth_providers": {
    "google": true,
    "github": false
  },
  "deploy_enabled": true,
  "active_workspace": {
    "id": "local",
    "slug": "local",
    "name": "Local",
    "role": "guest"
  }
}
```

## Better Auth Route Facts

- Better Auth is mounted at `/auth/*` in `apps/server/src/index.ts`.
- Social auth start is `POST /auth/sign-in/social`, not a browser `GET`.
- `GET /auth/sign-in/social?provider=google` returned `404`, matching the frontend comment in `apps/web/src/api/client.ts`.
- The frontend helper posts `{ provider, callbackURL }` and top-level navigates to the returned provider URL.

## Google

Verdict: **PASS**.

Evidence:

- `POST /auth/sign-in/social` with `provider=google`: HTTP `200`.
- Returned redirect host: `accounts.google.com`.
- Returned `redirect_uri`: `https://preview.floom.dev/auth/callback/google`.
- Playwright loaded the returned Google URL and captured the Google sign-in page.
- Google did not return a `redirect_uri_mismatch` or `invalid_request` page.

The verified callback path is:

```text
https://preview.floom.dev/auth/callback/google
```

## GitHub

Verdict: **DEFERRED**.

The live preview container has empty GitHub OAuth credentials:

- `GITHUB_OAUTH_CLIENT_ID`: empty
- `GITHUB_OAUTH_CLIENT_SECRET`: empty

The server reports `auth_providers.github=false` from `/api/session/me`, so the UI can hide the GitHub button. The route also fails closed without crashing:

```json
{
  "status": 503,
  "body": {
    "error": "GitHub auth not configured",
    "code": "provider_not_configured",
    "provider": "github"
  }
}
```

To enable GitHub OAuth, Federico needs to:

1. Create a GitHub OAuth app.
2. Add callback URL `https://preview.floom.dev/auth/callback/github`.
3. Add production callback URL `https://floom.dev/auth/callback/github` before prod promotion.
4. Set `GITHUB_OAUTH_CLIENT_ID` and `GITHUB_OAUTH_CLIENT_SECRET` in the deploy environment.
5. Restart the server and verify `/api/session/me.auth_providers.github=true`.

## Self-Audit

- Verified with the real Google OAuth client from the live preview container.
- Verified the Google provider page with Playwright screenshot evidence, not a loading state.
- Verified GitHub empty-credential behavior after adding the explicit non-crashing guard.
- Verified no production data path was used; the local verification server used `/tmp/floom-track-c-data`.
