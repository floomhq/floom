# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities **privately**. Do not open a public issue
for a suspected vulnerability.

- Use GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
  ("Report a vulnerability" under the repository's **Security** tab), or
- Email the maintainers at the address listed on the project page.

Please include: a description of the issue, the affected component
(API / web / MCP / worker runtime), reproduction steps or a proof of concept,
and the impact you have in mind. We aim to acknowledge reports within a few days.

## Scope

In scope: the API backend (`apps/api`), the web app (`apps/web`), the MCP server
(`apps/mcp`), and the worker execution model. Of particular interest:

- Authentication / authorization bypass (token handling, workspace isolation,
  the cross-member stock-worker visibility rules).
- Sandbox escape or host access from worker code (workers are expected to run in
  isolated E2B sandboxes, never in the API process).
- Secret or credential disclosure (share-link signing, upload signing, secret
  storage, error messages that leak provider details).
- Server-side request forgery, injection, or zip/path traversal in the
  worker-bundle and workspace-import paths.

Out of scope: issues that require a malicious operator who already has full admin
of their own self-hosted instance, and findings in third-party dependencies
(report those upstream, though we appreciate a heads-up).

## Handling secrets

Never commit real secrets. Configuration is provided via environment variables
(see `.env.example` and `apps/api/.env.example`); `.env` files and the `data/`
runtime directory are git-ignored. If you believe a secret was committed, report
it privately so it can be rotated and purged.
