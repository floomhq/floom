# Release checklist

The repo is in source-available release-candidate shape, but the final public
switch should wait for the release gates below. Keep this checklist aligned with
the current `main` branch rather than aspirational launch state.

_Last updated: 2026-06-21._

## Cleared

- **Security** - P0/P1 issues verified patched; no live secrets and no current
  infrastructure details in git history, so history is safe to publish as-is.
- **Hygiene** - Floom Source Available License, README badge, CONTRIBUTING, CODE_OF_CONDUCT,
  SECURITY, issue/PR templates, clean repo root, and package metadata.
- **Dependency review** - Dependabot plus third-party license/SBOM policy are
  documented for release review; generated SPDX SBOM lives in `docs/sbom/`.
- **Gates** - ruff lint gate and gitleaks secret-scan gate in CI.
- **Release tooling** - CHANGELOG and release-please are installed, currently
  manual.
- **Ownership** - CODEOWNERS assigns all changes to `@itachi-hue` and
  `@federicodeponte`.

## Do At Release

1. **Green CI on `main`** - api-tests, runtime-tests, web-tests, mcp-tests, ruff
   lint, dependency review, and gitleaks secret-scan must all pass on the release
   commit.
2. **Branch protection on `main`** - enable a rule or ruleset requiring PRs,
   green status checks, one Code Owner review, and no force-push. Keep admin
   bypass available for hotfixes. This GitHub-side setting is currently blocked
   while the private repo lacks branch-protection eligibility; enable it when
   the repository is public or the org plan supports it.
3. **Turn on releases** - in `.github/workflows/release.yml`, switch the trigger
   from `workflow_dispatch` back to `on: push: [main]`. release-please then
   opens release PRs; merging a release PR tags and publishes the GitHub
   release.
4. **Docker image and compose** - add Dockerfiles for `apps/api` and `apps/web`,
   `docker-compose.yml`, and publish `ghcr.io/floomhq/floom:<version>`.
5. **README screenshots or demo GIF** - useful for public launch because this is
   a visual product.
6. **Frontend onboarding** - document `FLOOM_API_BASE` and `FLOOM_API_SECRET`;
   stop defaulting to the production API in local examples.
7. **Public switch** - make this repository public after a final gitleaks scan
   and maintainer review.

## Optional Polish

- Expand the ruff ruleset by clearing the F401/F841 backlog file by file.
- Decompose `main.py`; remove `db/_legacy_sqlite.py`.
- Add coverage measurement for pytest and vitest.
- Publish the MCP npm package (`@floomhq/floom`) on release.
- Fold `pytest.ini` and `ruff.toml` into a single `pyproject.toml`.
