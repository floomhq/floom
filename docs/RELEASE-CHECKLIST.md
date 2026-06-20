# Release checklist

The repo is in source-available release-candidate shape, but the final public
switch should wait for the release gates below. Keep this checklist aligned with
the current `main` branch rather than aspirational launch state.

_Last updated: 2026-06-19._

## Cleared

- **Security** - P0/P1 issues verified patched; no live secrets and no current
  infrastructure details in git history, so history is safe to publish as-is.
- **Hygiene** - SUL-1.0 LICENSE, README badge, CONTRIBUTING, CODE_OF_CONDUCT,
  SECURITY, issue/PR templates, clean repo root, and package metadata.
- **Dependency review** - Dependabot plus third-party license/SBOM policy are
  documented for release review.
- **Gates** - ruff lint gate and gitleaks secret-scan gate in CI.
- **Release tooling** - CHANGELOG and release-please are installed, currently
  manual.

## Do At Release

1. **Green CI on `main`** - api-tests, runtime-tests, web-tests, mcp-tests, ruff
   lint, dependency review, and gitleaks secret-scan must all pass on the release
   commit.
2. **Branch protection on `main`** - enable a rule or ruleset requiring PRs,
   green status checks, one reviewer or Code Owner review, and no force-push.
   Keep admin bypass available for hotfixes.
3. **CODEOWNERS** - add maintainers or teams once the public review ownership
   model is final.
4. **Turn on releases** - in `.github/workflows/release.yml`, switch the trigger
   from `workflow_dispatch` back to `on: push: [main]`. release-please then
   opens release PRs; merging a release PR tags and publishes the GitHub
   release.
5. **Docker image and compose** - add Dockerfiles for `apps/api` and `apps/web`,
   `docker-compose.yml`, and publish `ghcr.io/floomhq/workeros:<version>`.
6. **README screenshots or demo GIF** - useful for public launch because this is
   a visual product.
7. **Frontend onboarding** - document `FLOOM_API_BASE` and `FLOOM_API_SECRET`;
   stop defaulting to the production API in local examples.
8. **Public switch** - make this repository public after a final gitleaks scan
   and maintainer review.

## Optional Polish

- Expand the ruff ruleset by clearing the F401/F841 backlog file by file.
- Decompose `main.py`; remove `db/_legacy_sqlite.py`.
- Add coverage measurement for pytest and vitest.
- Publish the MCP npm package (`@floomhq/workeros`) on release.
- Fold `pytest.ini` and `ruff.toml` into a single `pyproject.toml`.
