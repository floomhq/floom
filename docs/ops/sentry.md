# Sentry Operations

Floom uses hosted sentry.io for launch observability. Self-hosted Sentry adds
ops load that is not useful for launch-week traffic; the hosted free tier is
enough for the initial error volume.

## Env Vars

```bash
SENTRY_SERVER_DSN=
VITE_SENTRY_WEB_DSN=
```

- `SENTRY_SERVER_DSN`: runtime env var for `apps/server`. Empty disables server
  Sentry and logs `[sentry] DSN not set, error tracking disabled`.
- `VITE_SENTRY_WEB_DSN`: build-time env var for `apps/web`. Empty disables
  browser Sentry and logs `[sentry] disabled`.

Optional tags:

```bash
SENTRY_ENVIRONMENT=preview # or prod
COMMIT_SHA=<git-sha>
```

The browser infers `preview` from `preview.floom.dev` and `prod` from
`floom.dev` when `VITE_SENTRY_ENVIRONMENT` is not baked into the bundle.

## Provisioning

1. Create a hosted Sentry organization at https://sentry.io.
2. Create one Backend project for `floom-server`.
3. Create one React project for `floom-web`.
4. Copy each project DSN into the matching env var above.
5. For readable browser stacks, create an auth token with project release
   access and expose these during the preview Docker build:

```bash
SENTRY_AUTH_TOKEN=
SENTRY_ORG=floom
SENTRY_PROJECT=floom-web
```

`apps/web/vite.config.ts` uses the official `@sentry/vite-plugin`. When
`SENTRY_AUTH_TOKEN` is absent, production builds still generate source maps,
but the plugin does not upload them.

## Reading Errors

Open the Sentry project, then use Issues for grouped errors and Performance for
sampled traces. Filter by these tags:

- `service:floom-server` or `service:floom-web`
- `env:preview` or `env:prod`
- `commit:<git-sha>`

The server logs `[sentry] ready service=floom-server env=<env> commit=<sha>`
when initialized. The browser logs `[sentry] ready service=floom-web env=<env>
commit=<sha>` when the bundle contains `VITE_SENTRY_WEB_DSN`.

## PII Scrub Policy

Sentry payloads never include request bodies. The server drops request
`data`, `body`, and `cookies` fields before sending.

The server scrubber drops these headers from request payloads:

- `authorization`
- `cookie`
- `x-api-key`

Both server and browser scrub nested keys matching password, token, API key,
authorization, secret, or cookie. Browser Sentry also redacts sensitive URL
query params and removes common user-input fields from breadcrumbs.

## Sampling

- Server performance traces: `0.1` (10%).
- Browser performance traces: `0.05` (5%).

Adjust `tracesSampleRate` in:

- `apps/server/src/lib/sentry.ts`
- `apps/web/src/lib/sentry.ts`

Keep error capture enabled with low trace sampling during launch; error events
are not sampled by these settings.
