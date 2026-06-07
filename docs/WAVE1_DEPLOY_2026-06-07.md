# Wave 1 Deploy - 2026-06-07

## Scope

Executed the Wave 1 merge, deploy, and live verification brief for:

- OSS `floomhq/workeros` PRs #496, #492, #493, #532
- Cloud `floomhq/managed-deployment` PR #113

Issues were closed only after live verification comments were added, except for merge-keyword auto-closures; those received post-deploy verification comments after the deploy gate.

## PR Decisions

| Repo | PR | Decision | Result |
|---|---:|---|---|
| `floomhq/workeros` | #496 | GO | Merged first. Runtime `diff` dependency and lockfiles fixed. |
| `floomhq/workeros` | #492 | NO-GO as bundled; GO after split | Original PR carried a large unrelated/conflicting diff. Preserved FL1/FL3/FL5 in a clean split commit, backed up the bundled branch, force-updated the PR branch, then merged. |
| `floomhq/workeros` | #493 | GO | Merged UI polish FL4/6/7/8/9/10. |
| `floomhq/workeros` | #532 | GO | Merged assistant base-persona fallback/state fix. |
| `floomhq/managed-deployment` | #113 | GO | Rebased/cherry-picked onto current Cloud main, verified, then merged. |

## Merge SHAs

- OSS #496 merge: `e07be6228f14beb349f6bab7cfe908a2ca2163f0`
- OSS #492 split commit: `0f9011e25ae1a5a837da05c2d4d5a860bba67fab`
- OSS #492 merge: `50e4c3f32ea58bf298e0c46deb618bf416cd1d16`
- OSS #493 merge: `5f54f029f008c328a131af7954e24ec333cb23f0`
- OSS #532 merge: `5c865a5943a26fdf55aa84eb70ead73c98ff14e1`
- OSS Wave 1 API hotfix: `1af4201a61d65773b6aa4a65b8de6751dabf1930`
- Cloud #113 merge: `1b3569d24067e565ffcba89256a663dfa21b8d23`

## Verification Before Deploy

OSS:

- `python3 -m pytest apps/api/tests/test_local_workspaces.py apps/api/tests/test_multi_member.py apps/api/tests/test_contexts_system_packs.py apps/api/tests/test_request_body_size_middleware.py apps/api/tests/test_workspace_agent_endpoint.py -q`
  - `57 passed in 67.79s`
- `npm ci`
  - Passed; npm reported 2 existing moderate audit advisories.
- `npm test -- --run tests/api-workspace-base.test.ts`
  - 1 file / 1 test passed.
- `npm run lint`
  - Exit 0; existing warnings only.
- `npm run build`
  - Next build and TypeScript completed successfully.
- `git diff --check`
  - Passed.

Cloud:

- `git submodule update --init --recursive`
- `python3 -m py_compile apps/api/routes/auth.py scripts/configure_supabase_auth_emails.py`
- `python3 -m pytest tests/test_auth_email_flows.py tests/test_auth_error_logging.py -q`
  - `17 passed, 1 warning`
- Cloud root: `npm ci && npm run build`
  - Passed.
- Cloud web: `npm ci && npm run sync && npm run check-drift && npm run build`
  - Sync, drift check, Next build, and TypeScript passed.
- `git diff --check`
  - Passed.

Hotfix after live public upload verification found a Cloudflare 502 for early 413:

- Changed context uploads to bypass the early content-length middleware and let the bounded route reader return the friendly JSON 413.
- `python3 -m pytest apps/api/tests/test_request_body_size_middleware.py apps/api/tests/test_contexts_system_packs.py -q`
  - `14 passed in 15.66s`
- Broader API regression set:
  - `57 passed in 69.06s`

## Deploy Evidence

OSS API:

- Deployed with `/opt/workeros-api-deploy/ops/deploy-api.sh`.
- Final deployed SHA: `1af4201a61d65773b6aa4a65b8de6751dabf1930`
- DB backup: `/root/backups/manual/floom-predeploy-1780807250.db`
- Deploy script health, schema drift, and hard post-deploy smoke passed.
- Migration version: 59.

OSS web:

- Built and deployed from a clean linked Vercel project.
- Production domain: `https://workers.floom.dev`
- Production deploy URL: `https://workeros-at71ti8rb-fedes-projects-5891bd50.vercel.app`

Cloud API:

- Deployed to Railway service `managed-deployment-api`.
- Live health:
  - `https://workeros-api.floom.dev/healthz` returned `{"status":"ok","deploy":"cloud"}`.

Cloud dashboard:

- Built and deployed from the repo root so Vercel respected root directory `web`.
- Production domain: `https://workeros.floom.dev`
- Production deploy URL: `https://managed-deployment-dashboard-3wxqtt1eo-fedes-projects-5891bd50.vercel.app`

## Live Verification

FL1 worker visibility:

- Live public API `GET /workers?include_system=true&include_archived=true` returned:
  - total workers: 100
  - `owner_id=federico`: 99
  - private rows: 100
  - sample IDs: `weekly_update`, `cv_writeup`, `dach_compliance`, `reverse_match_crm`, `gmail_intake_brief`
- Live web proxy with a temporary backend session returned the same restored Federico-owned list.
- Temporary verification session rows were cleaned up.

FL3 Cloud login redirect:

- Fresh Cloud signup confirmation landed at `https://workeros.floom.dev/app/overview`.
- Screenshot evidence: `/root/ax-browser-broker/artifacts/screenshots/pool-b-1780806887555.png`
- The screenshot shows the signed-in Work done overview, not the home/marketing page.

FL5 Brain upload:

- Public `workers-api.floom.dev` accepted a 2 MiB upload into a newly-created temporary Brain folder:
  - HTTP 200
  - `total_size_bytes=2097152`
- Public `workers-api.floom.dev` returned the friendly cap error for a 27 MiB upload after the hotfix:
  - HTTP 413
  - `Brain upload is too large. Upload files up to 25 MB.`
- Temporary Brain context was deleted.

Assistant base-instructions editor:

- Live API `/workspace/base/state` returned HTTP 200 with the Emily base persona.
- Live web `/assistant` returned HTTP 200.
- Screenshot evidence: `/root/ax-browser-broker/artifacts/screenshots/pool-b-1780807401426.png`
- The screenshot shows the Base instructions editor populated with `# Emily` and the Emily dock, with no Not Found state.

Cloud magic-link parser fallback:

- Fresh signup email was fetched through the Gmail/Composio route.
- Extracted confirmation URL preserved `token_hash` and `type=signup`; no raw token is recorded in this report.
- Browser click-through reached `https://workeros.floom.dev/app/overview`.
- Screenshot evidence: `/root/ax-browser-broker/artifacts/screenshots/pool-b-1780806887555.png`

Launch smoke:

- Route smoke from the deploy script passed for OSS and Cloud routes with no 5xx/508.
- Emily `/chat` live API smoke returned SSE event types `chat.meta`, `text`, `finish`.
- Temporary worker create/run/delete live smoke:
  - worker created: `wave1-live-smoke-1780807359`
  - run created: `run_409c58449dbd`
  - final status: `completed`
  - output: `{"result":"wave1-ok:live"}`
  - worker deleted with HTTP 204.

## Issue Actions

Verified and closed:

- #499 FL3: closed after Cloud overview redirect screenshot.
- #501 FL5: closed after public 2 MiB upload and public friendly 413 cap verification.
- #531 assistant base editor: closed after live `/assistant` screenshot.
- #530 magic-link: closed after fresh Gmail confirmation click-through and overview screenshot.

Already auto-closed by merge keywords; post-deploy comments added:

- #497 FL1
- #500 FL4
- #502 FL6
- #503 FL7
- #504 FL8
- #505 FL9
- #506 FL10

## Notes

- The original #492 branch was preserved at `origin/backup/pr-492-bundled-20260607` before the clean split was force-pushed.
- A public-path upload verification failure was found after the first API deploy: the app logged 413, but Cloudflare returned 502 when middleware rejected by content length before body consumption. Commit `1af4201a61d65773b6aa4a65b8de6751dabf1930` fixed this and was deployed before closing #501.
- The first temporary worker smoke fixture failed because it did not write `result.json`, which is required by the sandbox worker protocol. The corrected fixture wrote `result.json`, completed successfully, and was cleaned up.
