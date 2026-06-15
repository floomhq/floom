# Release checklist

The repo is **publishable today** — every item that *gates* going public is done.
What's below is the deliberate at-launch batch plus optional polish. We're keeping
`main` unprotected (direct pushes) while still iterating; the protection/release
switches flip on at release time.

_Last updated: 2026-06-15._

## ✅ Already cleared — do not re-do
- **CI green on `main`** — api-tests, runtime-tests, web-tests, mcp-tests, ruff lint, gitleaks secret-scan.
- **Security** — P0/P1 (platform-secret override, `_upsert_env_var` newline injection) verified patched; 9 security issues fixed + closed; no live secrets and no current infra in git history (AX41 stale), so history is safe to publish as-is.
- **Hygiene** — MIT LICENSE, README + CI/license badges, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, issue/PR templates, real CODEOWNERS (`@federicodeponte` + `@itachi-hue`), clean repo root, package.json metadata.
- **Gates** — ruff lint gate and gitleaks secret-scan gate in CI.
- **Release tooling** — CHANGELOG + release-please installed (currently dormant).

## ⏳ Do at release
1. **Branch protection on `main`** (currently OFF so direct pushes work during dev). Enable a rule/ruleset requiring:
   - PR before merging (no direct pushes)
   - status checks green: `API tests (pytest)`, `Runtime tests (root pytest suite)`, `Web tests (vitest + tsx + lint)`, `MCP package tests`, `Python lint (ruff)`, `Secret scan (gitleaks)`
   - 1 review from **Code Owners**
   - no force-push; **allow admin bypass** for hotfixes (2-person team)
2. **Turn on releases** — in `.github/workflows/release.yml`, switch the trigger from `workflow_dispatch` back to `on: push: [main]`. release-please then opens a "release vX.Y.Z" PR; merging it tags + publishes. (Manifest is `0.0.0`; first release will be `0.1.0` from the `[Unreleased]` CHANGELOG section.)
3. **Docker image + compose** — `Dockerfile`s for `apps/api` + `apps/web`, a `docker-compose.yml`, and publish `ghcr.io/floomhq/workeros:<version>` on release. Biggest lever for runnability + a real demo path.
4. **README screenshots / demo GIF** — it's a visual product with no images today.
5. **Frontend onboarding** — document `FLOOM_API_BASE` / `FLOOM_API_SECRET`; stop defaulting to the prod API; replace the boilerplate `apps/web/README`.
6. **Public strategy decision** — make this repo public, *or* the monorepo + read-only FOSS-mirror plan. If mirroring: **allowlist-publish** (not strip-`cloud/`) + gitleaks-gated push; skip directory-level secrecy for now.

## 🔧 Optional polish (post-launch)
- Expand the ruff ruleset by clearing the F401/F841 backlog (file-by-file; bulk `--fix` is unsafe due to re-export shims).
- Decompose `main.py` (still ~6.9k lines); remove `db/_legacy_sqlite.py`.
- Add coverage measurement (`pytest-cov`, vitest coverage).
- Publish the MCP npm package (`@floomhq/workeros`) on release.
- Fold `pytest.ini` + `ruff.toml` into a single `pyproject.toml`.
- Align LICENSE holder wording with the README.
