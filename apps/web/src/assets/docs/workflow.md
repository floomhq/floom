# Developer workflow

The repo already ships a real CI and preview loop. It does **not** yet ship a full in-product versioning or staged-release UI for creators.

## What the repo supports now

- GitHub **CI** runs typecheck and tests on pushes and pull requests targeting `main`.
- Pushing `main` triggers **preview deploy** after CI succeeds.
- Production deploy stays **manual**.
- A rollback runbook exists and is checked like an operator playbook, not just a README wish.

## Publishing flow

- Build or ingest the app.
- Verify the change locally.
- Push reviewed code to `main`.
- Let preview deploy.
- Audit the real preview environment.
- Promote to production manually only after preview evidence is clean.

This is the repo-level shipping workflow today. It is separate from the future creator-facing draft, review, and publish product flow.

## Versioning

- Git is the source of truth for code changes.
- GitHub Actions is the source of truth for CI and preview gating.
- There is no public creator-facing semantic-version UI, release channel chooser, or point-in-time app restore surface in the product today.

## Staging and rollback

- Preview auto-deploys from `main` after the `Typecheck` and `Test` checks pass.
- Production is manual by policy.
- **Rollback in practice** (operator playbook): deploy the last known-good container image, hit `GET /api/health` and a short smoke test on critical paths, then shift traffic or confirm the live tag. Full steps live in the repo’s rollback runbook, including drill checklists.

## CI/CD integration

- The current integration point is GitHub Actions.
- Self-hosters can follow the same pattern with Docker image promotion and the rollback runbook.
- The product does **not** yet expose a built-in CI pipeline editor or release dashboard for creators.

## Related pages

- [/docs/limits](/docs/limits)
- [/docs/observability](/docs/observability)
- [/docs/reliability](/docs/reliability)
- [/docs/pricing](/docs/pricing)
