# Cloud `/app` 508 Regression Fix - 2026-06-05

## Summary

Live regression: `https://workeros.floom.dev/app` and dashboard deep links returned Vercel `508 INFINITE_LOOP_DETECTED`.

Fix shipped in PR #90, merged as `c29c6e5`:

- Added exact `/app` root coverage to dashboard middleware by adding `"/"` to the matcher. With `NEXT_PUBLIC_BASE_PATH=/app`, Next prepends the base path, so this matches exact `/app` and avoids falling through to `app/page.tsx`.
- Added `scripts/guard_vercel_project.mjs` to block a repo-root Vercel build in the `workeros-cloud-dashboard` project. That failure mode uploads the landing `vercel.json` into the dashboard project, making dashboard `/app` rewrite to dashboard `/app`.
- Kept `engine/` pinned at `e4df683df0f0b0207e536b077e073eb5f18f59de`.
- Confirmed `web/vercel.json` remains absent.

Production dashboard deployment:

- Deployment id: `dpl_9MEecC6vMiky2NNiVUsCo1uDwHV5`
- Alias: `https://workeros-cloud-dashboard.vercel.app`
- Deploy command run from `web/`: `npm run sync && vercel deploy --prod --yes --scope team_iZAvTKKpmU9cPwcH9qE9H9OX`

## Root Cause

There were two verified issues.

1. Exact basePath root `/app` was not covered by the dashboard middleware matcher.

   Local production before the matcher fix, with `NEXT_PUBLIC_BASE_PATH=/app`, showed:

   ```text
   /app
   HTTP/1.1 307 Temporary Redirect
   location: /app/overview
   HTTP/1.1 307 Temporary Redirect
   location: /app/login?next=%2Fapp%2Foverview
   HTTP/1.1 200 OK
   ```

   The exact `/app` request skipped middleware auth and hit `app/page.tsx`, which redirects to `/overview`. Adding `"/"` to `config.matcher` makes Next compile an exact basePath-root matcher for `/app`.

2. The live dashboard deployment was built from the repo root, not from `web/`.

   `vercel inspect https://workeros-cloud-dashboard.vercel.app` before the fix showed:

   ```text
   id    dpl_D33VfZZWybwUuVuxtmJt9kSjwg49
   name  workeros-cloud-dashboard
   Builds
     ┌ .        [0ms]
   ```

   The dashboard project root served the landing page:

   ```text
   https://workeros-cloud-dashboard.vercel.app
   title= Workeros: Hire AI workers for your company
   has dashboard login False
   has hire True
   ```

   Because the repo-root `vercel.json` contains:

   ```json
   {
     "source": "/app",
     "destination": "https://workeros-cloud-dashboard.vercel.app/app"
   }
   ```

   a root deploy into the dashboard project made `https://workeros-cloud-dashboard.vercel.app/app` rewrite to itself. Vercel detected that as an infinite loop and returned 508 before dashboard middleware could render a response.

## Before Curls

Captured before the deploy on 2026-06-05.

```text
### /app
HTTP/2 508
server: Vercel
x-vercel-id: arn1:arn1:arn1:arn1:arn1:arn1:arn1:arn1:arn1:arn1:arn1::dffv8-1780690566651-51460bbc7eea

### /app/overview
HTTP/2 508
server: Vercel
x-vercel-id: arn1:arn1:arn1:arn1:arn1:arn1:arn1:arn1:arn1:arn1:arn1::pbl4j-1780690566943-5942bb70101a

### /app/
HTTP/2 308
location: /app
server: Vercel
x-vercel-id: arn1::6nmsw-1780690567034-4ba7cd48079e
HTTP/2 508
server: Vercel
x-vercel-id: arn1:arn1:arn1:arn1:arn1:arn1:arn1:arn1:arn1:arn1:arn1::ncm2v-1780690567225-5df18d447b5a

### /app/runs
HTTP/2 508
server: Vercel
x-vercel-id: arn1:arn1:arn1:arn1:arn1:arn1:arn1:arn1:arn1:arn1:arn1::cfhtq-1780690567483-118fb25cc1f3

### /app/login
HTTP/2 508
server: Vercel
x-vercel-id: arn1:arn1:arn1:arn1:arn1:arn1:arn1:arn1:arn1:arn1:arn1::c229w-1780690567582-f7c2c3841dc2

### /app/workers
HTTP/2 508
server: Vercel
x-vercel-id: arn1:arn1:arn1:arn1:arn1:arn1:arn1:arn1:arn1:arn1:arn1::zp9qd-1780690567673-ef307666c81b

### /app/workers/granola-hubspot-meeting-actions
HTTP/2 508
server: Vercel
x-vercel-id: arn1:arn1:arn1:arn1:arn1:arn1:arn1:arn1:arn1:arn1:arn1::27s9l-1780690567837-acc9a12f55ad

### /app/runs/run_8290101e249b
HTTP/2 508
server: Vercel
x-vercel-id: arn1:arn1:arn1:arn1:arn1:arn1:arn1:arn1:arn1:arn1:arn1::mv6h7-1780690567934-f25faf0e82f5
```

## Local After Trace

Local production after the matcher fix:

```text
### /app
HTTP/1.1 307 Temporary Redirect
location: /app/login?next=%2Fapp
HTTP/1.1 200 OK

### /app/overview
HTTP/1.1 307 Temporary Redirect
location: /app/login?next=%2Fapp%2Foverview
HTTP/1.1 200 OK

### /app/workers/granola-hubspot-meeting-actions
HTTP/1.1 307 Temporary Redirect
location: /app/login?next=%2Fapp%2Fworkers%2Fgranola-hubspot-meeting-actions
HTTP/1.1 200 OK
```

## Live After Curls

Captured after deploying dashboard `dpl_9MEecC6vMiky2NNiVUsCo1uDwHV5`.

```text
### /app
HTTP/2 307
location: /app/login?next=%2Fapp
server: Vercel
x-vercel-id: arn1:arn1:arn1::gl5p6-1780691223149-6c59aa2b83db
HTTP/2 200
server: Vercel
x-vercel-id: arn1:arn1:arn1::iad1::gl5p6-1780691223551-9cdbf6a9b2c3

### /app/overview
HTTP/2 307
location: /app/login?next=%2Fapp%2Foverview
server: Vercel
x-vercel-id: arn1:arn1:arn1::9znr9-1780691225228-8f7dda02bc77
HTTP/2 200
server: Vercel
x-vercel-id: arn1:arn1:arn1::iad1::54lh2-1780691225597-a1919b3dd788

### /app/login
HTTP/2 200
server: Vercel
x-vercel-id: arn1:arn1:arn1::iad1::8b7wv-1780691225994-642115a175ba

### /app/workers
HTTP/2 307
location: /app/login?next=%2Fapp%2Fworkers
server: Vercel
x-vercel-id: arn1:arn1:arn1::27s9l-1780691226210-9d5c23a3d67c
HTTP/2 200
server: Vercel
x-vercel-id: arn1:arn1:arn1::iad1::gl5p6-1780691226412-72caa637ffa1

### /app/runs
HTTP/2 307
location: /app/login?next=%2Fapp%2Fruns
server: Vercel
x-vercel-id: arn1:arn1:arn1::j8vsz-1780691226649-f504a1181ba7
HTTP/2 200
server: Vercel
x-vercel-id: arn1:arn1:arn1::iad1::gl5p6-1780691226689-07835b4b6a87

### /app/workers/granola-hubspot-meeting-actions
HTTP/2 307
location: /app/login?next=%2Fapp%2Fworkers%2Fgranola-hubspot-meeting-actions
server: Vercel
x-vercel-id: arn1:arn1:arn1::fxv44-1780691226915-fcd5c3f27718
HTTP/2 200
server: Vercel
x-vercel-id: arn1:arn1:arn1::iad1::fxv44-1780691227132-4cd93fad0955

### /app/runs/run_8290101e249b
HTTP/2 307
location: /app/login?next=%2Fapp%2Fruns%2Frun_8290101e249b
server: Vercel
x-vercel-id: arn1:arn1:arn1::pbwwb-1780691227459-d139d2c52be7
HTTP/2 200
server: Vercel
x-vercel-id: arn1:arn1:arn1::iad1::7vqnz-1780691227500-cbc27e7245a0
```

Authenticated-shaped middleware pass-through check used a fake non-secret payload:

```text
### authed-shaped /app/overview
HTTP/2 200

### authed-shaped /app/workers
HTTP/2 200

### authed-shaped /app/runs
HTTP/2 200
```

## Verification

Local verification before merge/deploy:

```text
npm run build
cd web && npm run lint
cd web && npm run build
cd web && npm run check-drift
git -C engine rev-parse HEAD
test ! -e web/vercel.json
```

Results:

- Root build passed.
- Dashboard lint exited 0 with warnings only.
- Dashboard build passed.
- Drift guard passed: synced tree matches `engine/apps/web`, overlay excluded.
- Engine pin: `e4df683df0f0b0207e536b077e073eb5f18f59de`.
- `web/vercel.json` absent.

PR #90 CI note:

- GitHub `Cloud tests (pytest)` and `drift-check` failed after 3 seconds with zero recorded steps and no logs.
- The dashboard Vercel preview failed because the new guard blocked a repo-root build in the dashboard project. That failure was expected and verified with `vercel inspect dpl_B7AXtcjZf1UGnNWQusVEwkHFjgim --logs`.
- The landing Vercel preview passed.
