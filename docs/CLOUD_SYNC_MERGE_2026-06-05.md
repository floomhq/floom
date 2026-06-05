# Cloud Sync Merge Report - 2026-06-05

Status: BLOCKED before merge
Branch: `codex/cloud-launch-fixes-20260605`
Latest pushed SHA: `45fd6f59bdda6a7da8be20782625e9e68889490b`
PR: https://github.com/floomhq/workeros-cloud/pull/86

## Completed

### Engine Target

Verified WorkerOS `main` and production both point at:

`099864073486e544e95e88190d9dac6a11ac3c89`

Evidence:

```text
gh api repos/floomhq/workeros/commits/main
sha: 099864073486e544e95e88190d9dac6a11ac3c89
date: 2026-06-05T18:30:42Z
message: fix(ui): M57 - OAuth callback session loss (fetch+router.replace) (#441)
```

```text
Vercel deployment API for workers.floom.dev production:
id: dpl_6jbenifxcf4QTjgstDe8XCXgbtPv
readyState: READY
createdAt: 1780684246602
meta.githubOrg: floomhq
meta.githubRepo: workeros
meta.githubCommitRef: main
meta.githubCommitSha: 099864073486e544e95e88190d9dac6a11ac3c89
gitSource.sha: 099864073486e544e95e88190d9dac6a11ac3c89
```

### PR #86 Engine Bump

Committed and pushed:

```text
b425411 chore(engine): bump WorkerOS to 0998640
45fd6f5 chore(api): record dependency audit verification
```

The PR branch now pins `engine/` at `099864073486e544e95e88190d9dac6a11ac3c89`.

`web/vercel.json` stayed deleted/absent:

```text
git ls-files --stage web/vercel.json
# no output

test ! -e web/vercel.json
exit code: 0
```

### Dashboard Verification

Commands run from `/tmp/workeros-cloud-86/web`:

```text
npm ci
npm run sync
npm run check-drift
npm run build
```

Evidence:

```text
npm run sync
[sync] done: 156 engine files copied, 31 overlay files layered, 0 stale engine file(s) skipped.
```

```text
npm run check-drift
[drift] PASS: synced tree matches engine/apps/web (overlay excluded). Zero drift.
```

```text
npm run build
Compiled successfully
Running TypeScript ...
Finished TypeScript
Generating static pages using 11 workers (33/33)
```

Note: `npm ci` completed and npm reported two moderate Node advisories. The requested Python audit is clean below.

### Cloud API Dependency Verification

Commands run from `/tmp/workeros-cloud-86`:

```text
python3 -m venv /tmp/workeros-cloud-86/.venv-api
/tmp/workeros-cloud-86/.venv-api/bin/python -m pip install --upgrade pip setuptools wheel
/tmp/workeros-cloud-86/.venv-api/bin/pip install -r apps/api/requirements.txt
/tmp/workeros-cloud-86/.venv-api/bin/pip check
python3 -m venv /tmp/workeros-pip-audit
/tmp/workeros-pip-audit/bin/python -m pip install --upgrade pip pip-audit
/tmp/workeros-pip-audit/bin/pip-audit -r apps/api/requirements.txt
```

Evidence:

```text
pip install -r apps/api/requirements.txt
Successfully installed ... cryptography-48.0.0 ... psycopg-3.2.9 ... supabase-2.31.0 ... websockets-15.0.1 ...
```

```text
pip check
No broken requirements found.
```

```text
pip-audit -r apps/api/requirements.txt
No known vulnerabilities found
```

## Blocker

PR #86 cannot be merged under the requested "after green" condition because both required GitHub Actions jobs fail before any runner starts.

Rerun evidence:

```text
gh pr checks 86 --watch --interval 10
Cloud tests (pytest)  fail  3s
drift-check           fail  2s
Vercel Preview Comments        pass
Vercel - workeros-cloud-dashboard  pass
Vercel - workeros-cloud-landing    pass
```

GitHub job metadata:

```text
drift-check:
runner_id: 0
runner_name: ""
steps: []

Cloud tests (pytest):
runner_id: 0
runner_name: ""
steps: []
```

Exact GitHub annotation on both failed check runs:

```text
The job was not started because recent account payments have failed or your spending limit needs to be increased. Please check the 'Billing & plans' section in your settings
```

GitHub Actions is enabled for the repo:

```text
gh api repos/floomhq/workeros-cloud/actions/permissions
enabled: true
allowed_actions: all
sha_pinning_required: false
```

## Not Performed

Because PR #86 is blocked before green checks:

- PR #86 was not merged.
- PR #85 was not closed.
- Branch `cloud-engine-sync-20260605` was not deleted.
- The new FORCE ROW LEVEL SECURITY migration was not added or applied.
- Production dashboard was not deployed.
- `workeros-cloud-api` was not bumped or restarted.
- Live `/app` verification after deploy was not run.

## Required Unblock

Resolve the GitHub account billing/spending-limit issue so `ubuntu-latest` jobs can start, then rerun PR #86 checks. After both GitHub checks are green, continue with merge, stale PR cleanup, FORCE RLS migration, dashboard deploy, API restart if needed, and live verification.
