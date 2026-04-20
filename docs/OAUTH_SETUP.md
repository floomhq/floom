# OAuth Setup (Google + GitHub)

Floom supports "Continue with Google" and "Continue with GitHub" on
`/login` and `/signup`. Both are optional. When the matching env vars
aren't set, the button doesn't render — no dead buttons, no trust hits.

Only works when `FLOOM_CLOUD_MODE=true`. In OSS mode there's no Better
Auth, so there's no OAuth.

## 1. Create the OAuth apps

### Google

1. Go to https://console.cloud.google.com/apis/credentials
2. Click **Create Credentials → OAuth client ID**
3. Application type: **Web application**
4. Name: `Floom` (or whatever you want)
5. Authorized redirect URIs: add **one** line
   - `<BETTER_AUTH_URL>/auth/callback/google`
   - e.g. `https://floom.dev/auth/callback/google`
   - For local dev: `http://localhost:3051/auth/callback/google`
6. Copy the **Client ID** and **Client secret** (these map to `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`).

### GitHub

1. Go to https://github.com/settings/developers → **OAuth Apps → New OAuth App**
2. Application name: `Floom`
3. Homepage URL: `<BETTER_AUTH_URL>` (e.g. `https://floom.dev`)
4. Authorization callback URL: `<BETTER_AUTH_URL>/auth/callback/github`
   - e.g. `https://floom.dev/auth/callback/github`
5. Register and generate a **Client secret**. Copy both (these map to `GITHUB_OAUTH_CLIENT_ID` and `GITHUB_OAUTH_CLIENT_SECRET`).

## 2. Set the env vars

On the Floom host, edit `/opt/floom-mcp-preview/.env` (preview) and/or
`/opt/floom-deploy/.env` (prod):

```bash
FLOOM_CLOUD_MODE=true
BETTER_AUTH_SECRET=<openssl rand -hex 32>
BETTER_AUTH_URL=https://floom.dev

GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...

GITHUB_OAUTH_CLIENT_ID=...
GITHUB_OAUTH_CLIENT_SECRET=...
```

Set only the providers you want. The other button hides itself.

## 3. Reload the container

No rebuild needed; these env vars are read at process start.

```bash
cd /opt/floom-mcp-preview
docker compose up -d
```

or equivalently `docker restart <container>`.

## 4. Verify

1. Visit `https://floom.dev/login`. You should see the new buttons above
   the email/password form, with a `— or continue with email —` divider.
2. Click "Continue with GitHub" or "Continue with Google".
3. Approve the scope on the provider's consent screen.
4. You get redirected back to Floom, land on `/studio/build` (new account)
   or `/me` (returning user), and the top bar shows your name and avatar.

If a button is missing: check the env vars on the host (`docker compose
exec <svc> env | grep OAUTH`). Both `OAUTH_CLIENT_ID` and `OAUTH_CLIENT_SECRET` have to be non-empty for the button to show.

If the redirect fails with "redirect_uri_mismatch": the URL you pasted
in the provider console doesn't match `<BETTER_AUTH_URL>/auth/callback/<provider>`.
Fix the provider config, no Floom redeploy needed.
