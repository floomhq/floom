# Release checklist

The repo is **publishable today** - every item that gates going public is done.
What's below is the deliberate at-launch batch plus optional polish. We're
keeping `main` unprotected while still iterating; the protection and release
switches flip on at release time.

_Last updated: 2026-06-19._

## Already Cleared

- **CI green on `main`** - api-tests, runtime-tests, web-tests, mcp-tests, ruff
  lint, and gitleaks secret-scan.
- **Security** - P0/P1 issues verified patched; no live secrets and no current
  infrastructure details in git history, so history is safe to publish as-is.
- **Hygiene** - SUL-1.0 LICENSE, README badge, CONTRIBUTING, CODE_OF_CONDUCT,
  SECURITY, issue/PR templates, CODEOWNERS, clean repo root, and package
  metadata.
- **Gates** - ruff lint gate and gitleaks secret-scan gate in CI.
- **Release tooling** - CHANGELOG and release-please are installed, currently
  manual.

## Do At Release

1. **Branch protection on `main`** - enable a rule or ruleset requiring PRs,
   green status checks, one Code Owner review, and no force-push. Keep admin
   bypass available for hotfixes.
2. **Turn on releases** - in `.github/workflows/release.yml`, switch the trigger
   from `workflow_dispatch` back to `on: push: [main]`. release-please then
   opens release PRs; merging a release PR tags and publishes the GitHub
   release.
3. **Docker image and compose** - add Dockerfiles for `apps/api` and `apps/web`,
   `docker-compose.yml`, and publish `ghcr.io/floomhq/workeros:<version>`.
4. **README screenshots or demo GIF** - useful for public launch because this is
   a visual product.
5. **Frontend onboarding** - document `FLOOM_API_BASE` and `FLOOM_API_SECRET`;
   stop defaulting to the production API in local examples.
6. **Public switch** - make this repository public after a final gitleaks scan
   and maintainer review.

## Optional Polish

- Expand the ruff ruleset by clearing the F401/F841 backlog file by file.
- Decompose `main.py`; remove `db/_legacy_sqlite.py`.
- Add coverage measurement for pytest and vitest.
- Publish the MCP npm package (`@floomhq/workeros`) on release.
- Fold `pytest.ini` and `ruff.toml` into a single `pyproject.toml`.
