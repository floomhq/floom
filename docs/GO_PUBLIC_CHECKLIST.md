# Go-public checklist (before flipping floomhq/floom to public)

Run this checklist before `gh repo edit floomhq/floom --visibility public`.
Last audit: 2026-04-17 (see `/var/www/wireframes-floom/autonomous/2026-04-17-pre-public-audit.md`).

## Secret audit — all items must be checked at the moment of flipping

- [ ] `gitleaks detect --source /root/floom --redact --verbose --no-git` returns 0 real findings (jwt.io demo tokens and hardcoded test fixtures in `test/stress/*.mjs` are OK)
- [ ] `gitleaks detect --source /root/floom --log-opts="--all" --redact --verbose` — zero NEW findings beyond those documented in the 2026-04-17 audit
- [ ] No `.env`, `.pem`, `.key`, `credentials.json`, `.db` files tracked (`git ls-files | grep -E '\.(env|pem|key|db|sqlite)$'` returns empty; `.env.example` is the only permitted match)
- [ ] `apps/server/src/db/seed.json` contains only `REDACTED_*` placeholders (no `AIza...`, no hex tokens)
- [ ] `docker/.env.example` — every value is commented or a generic placeholder
- [ ] All workflows in `.github/workflows/*` reference only `secrets.GITHUB_TOKEN` (or other `secrets.*`), no hardcoded creds, no `pull_request_target` without explicit secret scoping
- [ ] No real keys in `docs/` or `examples/` (greppable, confirmed in audit)

## Known history findings (documented, accepted by Federico)

The initial commit `0459f91d` ("Initial commit — Floom monorepo", 2026-04-13) contains:
- A real Gemini API key (`AIzaSy...Ey9w`) in `apps/server/src/db/seed.json` lines 1471-1498
- A real FlyFast internal token (`030324...6061`) in `apps/server/src/db/seed.json` line 1475

Both were removed in a subsequent commit and replaced with `REDACTED_*` placeholders. They remain in git history.

### Rotation checklist (before going public)

- [ ] Rotate the Gemini API key at https://aistudio.google.com/apikey (revoke `AIzaSyD6g6xI2yLyb9gig88oSEmAvKEKcMwEy9w`, generate new, update wherever used: `memory/credentials.md`, OpenDraft, OpenSlides, OpenBlog, OpenKeyword, OpenAnalytics, OpenGTM, Claude-Wrapped, OpenContext, Bouncer)
- [ ] Rotate `FLYFAST_INTERNAL_TOKEN` on the FlyFast API server (Hetzner) and any Floom/self-host installation using it
- [ ] After rotation, the history exposure is defanged — the leaked values authenticate to nothing
- [ ] Choose path forward:
  - [ ] **Option A (pragmatic)** — rotate + accept the history. Leaked values are dead keys, safe to stay in history.
  - [ ] **Option B (clean)** — after rotation, rewrite history with `git filter-repo --replace-text <patterns>` or `bfg --replace-text`. Forces all collaborators and forks to re-clone. Not worth it for dead keys on a pre-public repo with one committer.

## Visibility flip

- [ ] Confirm the two rotations above are done
- [ ] `gh repo edit floomhq/floom --visibility public --accept-visibility-change-consequences`
- [ ] Verify the repo is accessible without auth: `curl -s -o /dev/null -w '%{http_code}' https://github.com/floomhq/floom` returns 200
- [ ] Enable Discussions if wanted: `gh api -X PATCH repos/floomhq/floom -f has_discussions=true`
- [ ] Verify issue templates still work

## Post-flip monitoring (first 48 hours)

- [ ] Watch GitHub secret-scanning alerts at https://github.com/floomhq/floom/security/secret-scanning
- [ ] Watch for unusual API usage on the Gemini console (the old key is dead, but catch any surprise)
- [ ] Watch FlyFast logs for auth failures with the old token

## Re-run this checklist after any significant commit landed during launch week
