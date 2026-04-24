# scripts/ops

Operational scripts that run on Floom infrastructure. These live in the
repo for reviewable history, but they execute **outside** the Next.js app
(no webpack, no bundler). Treat them as system-level infra.

## floom-deploy-preview.sh

Rolls both Floom public-facing containers on every push to `main`:

| Container              | Port | Role                           | `DEPLOY_ENABLED` |
| ---------------------- | ---- | ------------------------------ | ---------------- |
| `floom-mcp-preview`    | 3051 | prod — serves `floom.dev`      | `false`          |
| `floom-preview-launch` | 3052 | preview — serves `preview.floom.dev` | `true`     |

Behavior:

1. Fetches `main` into `/opt/floom-deploy-src/` (a dedicated clone — never
   `/root/floom`, which is a shared worktree).
2. Builds ONE image tagged `floom-preview-local:auto-<sha>`.
3. Swaps the `image:` line in both compose files (prod + preview).
4. `docker compose up -d --no-deps` for both services.
5. Health-checks both (`/api/health` on 3051 and 3052, up to 60 s each).
6. If **either** health check fails, restores **both** compose backups and
   rolls both services back. The deploy is atomic: both move forward
   together, or both stay on the previous image.

Environment variable differences between prod and preview (including
`DEPLOY_ENABLED`, `PUBLIC_URL`, `CANONICAL_ORIGIN`, volume mounts) live in
the respective compose files. This script only rewrites the image tag —
it never touches env vars.

### Where it runs

- Live path on AX41: `/usr/local/sbin/floom-deploy-preview.sh`
- Invoked via forced-command SSH from the `ci/auto-deploy-preview-*` GitHub
  Actions workflow.
- Log: `/var/log/floom-deploy-preview.log`

### How to update

The repo copy is the source of truth. To change deploy behavior:

1. Edit `scripts/ops/floom-deploy-preview.sh` in this repo.
2. Open a PR, get it reviewed, merge to `main`.
3. SSH to AX41 and copy into place:

   ```bash
   sudo cp /opt/floom-deploy-src/scripts/ops/floom-deploy-preview.sh \
           /usr/local/sbin/floom-deploy-preview.sh
   sudo chmod +x /usr/local/sbin/floom-deploy-preview.sh
   ```

   (`/opt/floom-deploy-src/` is already kept in sync with `main` by the
   deploy script itself on every push.)

4. Trigger a deploy via GitHub Actions `workflow_dispatch` on the
   `ci/auto-deploy-preview-*` workflow, or wait for the next push to
   `main`. The next run will use the updated script.

### Why this file is checked in

The script is system-level infra, not part of the app bundle. Keeping it in
the repo:

- gives it reviewable history (every change goes through PR)
- prevents the kind of drift that caused the 2026-04-24 incident, where
  `preview.floom.dev` ran stale code for ~1 hour because the deploy hook
  only touched prod
- makes it obvious to anyone reading the codebase how deploys actually
  work
