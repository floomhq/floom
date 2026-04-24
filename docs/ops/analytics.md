# Analytics & SEO operations

Wiring for search-engine verification and PostHog product analytics on
floom.dev. Scoped to ops steps humans have to perform — no code lives here.

## Google Search Console verification (issue #598)

Floom's prod domain (`floom.dev`) is claimed in Google Search Console via
the HTML meta tag verification method. Preview (`preview.floom.dev`) is
intentionally NOT claimed — it ships `X-Robots-Tag: noindex, nofollow` plus
a `<meta name="robots" content="noindex, nofollow">` tag (see
`apps/server/src/middleware/security.ts` and issue #630) so there is
nothing for Google to index there.

**Token env var:** `FLOOM_GSC_VERIFICATION_TOKEN`

The server reads this at boot inside `apps/server/src/index.ts`. When set
AND the deployment is not a preview (i.e. `PUBLIC_URL` does not contain
`preview.`), the token is injected into the SSR-rendered `index.html` as:

```html
<meta name="google-site-verification" content="<TOKEN>" />
```

When unset the tag is omitted — the site still builds and serves cleanly.
The middleware does NOT inject this tag on preview deployments.

### One-time setup

1. Open <https://search.google.com/search-console>.
2. Add property → **URL prefix** → `https://floom.dev` (not `preview.`).
3. Pick the **HTML tag** verification method. Google generates a token
   string (looks like `abcDEF123_xyz...`).
4. In the Floom prod deployment, set the repo/environment secret:
   - GitHub Actions: `FLOOM_GSC_VERIFICATION_TOKEN` (Repository Secrets).
   - Hetzner compose/systemd: add to the `.env` next to `PUBLIC_URL`.
5. Redeploy. Confirm the tag is in the SSR HTML:

   ```bash
   curl -s https://floom.dev/ | grep google-site-verification
   ```

6. Back in Search Console, click **Verify**. Google fetches `/` and looks
   for the tag. Expect success within a few seconds.
7. Submit the sitemap: `https://floom.dev/sitemap.xml` (lives in the SPA
   dist). Indexing starts rolling in within ~24h; full coverage can take
   days depending on crawl budget.

### Rotating the token

Search Console recommends leaving the verification tag in place. If you
must rotate, generate a new token in Search Console (same flow as above),
update `FLOOM_GSC_VERIFICATION_TOKEN`, redeploy, re-verify, then remove the
old tag from your records.

## PostHog product analytics (issue #599)

Frontend-only. Config + event catalog live in `apps/web/src/lib/posthog.ts`.

- Key: `VITE_POSTHOG_KEY` (build-time, baked into the bundle)
- Host: `VITE_POSTHOG_HOST` (defaults to `https://eu.i.posthog.com`)

PostHog is strictly consent-gated. It only boots when the user picks
"Accept all" in `CookieBanner.tsx`; "Essential only" keeps it fully dark
even with a key configured. Session replay, autocapture, and pageleave
tracking are disabled on purpose — we track a hand-curated event catalog
instead of a firehose.

### Current event catalog

| Event                | Fired from                                         | Props                                 |
|----------------------|----------------------------------------------------|---------------------------------------|
| `landing_viewed`     | `main.tsx` on first load of `/`                    | —                                     |
| `page_view`          | `main.tsx` (`RouteChangeTracker`) on every route change | `{ path }`                       |
| `publish_clicked`    | `CreatorHeroPage.tsx` on "Publish" CTA             | (source props per page)               |
| `publish_succeeded`  | `api/client.ts` after a successful create-app call | `{ slug }`                            |
| `signup_completed`   | `LoginPage.tsx` after 200 from `/auth/sign-up`     | —                                     |
| `signin_completed`   | `LoginPage.tsx` after 200 from `/auth/sign-in`     | —                                     |
| `run_triggered`      | `api/client.ts` on `startRun()` entry              | `{ app_slug, action }`                |
| `run_succeeded`      | `api/client.ts` on 2xx run completion              | `{ run_id, app_slug }`                |
| `run_failed`         | `api/client.ts` on non-2xx run completion          | `{ run_id, app_slug, status }`        |
| `share_link_opened`  | `PublicRunPermalinkPage.tsx` on mount              | `{ run_id }`                          |
| `waitlist_join`      | `WaitlistModal.tsx`, `WaitlistPage.tsx` on submit  | `{ source }`                          |
| `byok_modal_open`    | `BYOKModal.tsx` on open                            | `{ mode, slug, usage, limit }`        |
| `docker_copy_click`  | `components/home/SelfHostSection.tsx` on click     | `{ surface }`                         |

### Verifying events fire

1. Accept all cookies (open devtools first, clear `floom_consent` if needed).
2. Open devtools → Network → filter by `e.posthog.com` or `i.posthog.com`.
3. Navigate: every route change should produce one `page_view`.
4. Copy the docker command on the self-host band: one `docker_copy_click`.
5. Open the waitlist modal from the hero CTA and submit a dummy email
   (preview env is fine) — one `waitlist_join`.

If nothing fires: check `VITE_POSTHOG_KEY` is set at build time and the
consent banner was actually accepted (not dismissed). In dev `MODE=development`
still runs PostHog the same way; it's consent-gated, not env-gated.

### Adding new events

The `TrackedEvent` union in `apps/web/src/lib/posthog.ts` is the source of
truth. Adding an event is a code change on purpose: it forces a PR review,
an entry in the table above, and a thought about whether the event is
really needed.
