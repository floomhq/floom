# Branch Protection

`main` should be protected before the public release.

Required maintainers:

- `@itachi-hue`
- `@federicodeponte`

Required rule for `main`:

- Require pull requests before merging.
- Require one approving review.
- Require review from Code Owners.
- Dismiss stale approvals when new commits are pushed.
- Require status checks to pass before merging.
- Require branches to be up to date before merging.
- Require conversation resolution before merging.
- Block force pushes.
- Block deletions.
- Allow administrator bypass for emergency hotfixes only.

Required checks once CI is green:

- `Python lint`
- `Secret scan`
- `Runtime tests (ubuntu-latest)`
- `Runtime tests (windows-latest)`
- `Web lint`
- `MCP tests`
- `Dependency review` after the repository is public

GitHub currently returns a branch-protection eligibility error for the private
repository. Enable this rule after making the repository public or upgrading the
org plan so private branch protection is available.
