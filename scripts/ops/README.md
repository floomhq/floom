# scripts/ops

Operational scripts that run on Floom infrastructure. These live in the
repo for reviewable history, but they execute **outside** the Next.js app
(no webpack, no bundler). Treat them as system-level infra.

## The 4-step ship workflow (locked 2026-04-24)

Every Floom change ships through four gates:

1. **GitHub issue** exists (file one first per the "GH issues for
   everything" rule).
2. **Fix and push to preview.** Merge the PR to `main` — the
   `Deploy preview` workflow (`.github/workflows/deploy-preview.yml`)
   auto-deploys to `preview.floom.dev` only. `floom.dev` is not touched.
3. **Review on preview.** Visually verify the change on
   `preview.floom.dev` (screenshot, DOM check, quick session).
4. **Deploy to prod.** Trigger the `Deploy prod` workflow
   (`.github/workflows/deploy-prod.yml`) manually via `workflow_dispatch`
   in GitHub Actions. With no input it promotes whatever image is
   currently live on preview. You can pass a specific image tag
   (e.g. `auto-abc1234`) to deploy an older build.

Two scripts implement this, with hard separation: each script touches
exactly one container and each has its own SSH deploy key on AX41. The
preview key cannot run the prod script, and vice versa.

## floom-deploy-preview.sh (preview auto-deploy)

Rolls the preview container on every push to `main`:

| Container              | Port | Role                                  | `DEPLOY_ENABLED` |
| ---------------------- | ---- | ------------------------------------- | ---------------- |
| `floom-preview-launch` | 3052 | preview — serves `preview.floom.dev`  | `true`           |

Behavior:

1. Fetches `main` into `/opt/floom-deploy-src/` (a dedicated clone — never
   `/root/floom`, which is a shared worktree).
2. Builds ONE image tagged `floom-preview-local:auto-<sha>`.
3. Swaps the `image:` line in `/opt/floom-preview-launch/docker-compose.yml`
   only. Backup goes to `docker-compose.yml.bak.auto-<ts>`.
4. `docker compose up -d --no-deps floom-preview-launch`.
5. Health-checks `http://127.0.0.1:3052/api/health` for up to 60 s.
6. Runs `scripts/ops/launch-apps-real-run-gate.sh` against preview:
   each launch app must finish with `dry_run=false`, `model!="dry-run"`,
   and under the run-time budget (30s default).
7. On failure (health or gate), restores the preview compose backup and rolls preview
   back. Prod compose and container are never touched.

### Where it runs

- Live path on AX41: `/usr/local/sbin/floom-deploy-preview.sh`
- Invoked via forced-command SSH from `.github/workflows/deploy-preview.yml`.
- Log: `/var/log/floom-deploy-preview.log`

## floom-deploy-prod.sh (prod manual deploy)

Rolls the prod container when manually triggered:

| Container              | Port | Role                             | `DEPLOY_ENABLED` |
| ---------------------- | ---- | -------------------------------- | ---------------- |
| `floom-mcp-preview`    | 3051 | prod — serves `floom.dev`        | `false`          |

Behavior:

1. Accepts one argument: the docker image tag to deploy. Empty means
   "promote whatever is currently live on preview". The argument is
   validated against `^[A-Za-z0-9:._-]+$`; anything else is rejected.
2. Verifies the resolved image exists in the local docker registry.
   Prod does not build — it only promotes an image built earlier by
   `floom-deploy-preview.sh`.
3. Swaps the `image:` line in `/opt/floom-mcp-preview/docker-compose.yml`
   only. Backup goes to `docker-compose.yml.bak.prod-<ts>` (a distinct
   suffix from the preview script's backups so the two cannot be
   confused during a cross-contamination check).
4. `docker compose up -d --no-deps floom-mcp-preview`.
5. Health-checks `http://127.0.0.1:3051/api/health` for up to 60 s.
6. Runs `scripts/ops/launch-apps-real-run-gate.sh` against prod:
   each launch app must finish with `dry_run=false`, `model!="dry-run"`,
   and under the run-time budget (30s default).
7. On failure (health or gate), restores the prod compose backup and rolls prod back.
   Preview compose and container are never touched.

### Where it runs

- Live path on AX41: `/usr/local/sbin/floom-deploy-prod.sh`
- Invoked via forced-command SSH from `.github/workflows/deploy-prod.yml`.
- Log: `/var/log/floom-deploy-prod.log`

## AX41 SSH setup (deploy keys)

Environment variable differences between prod and preview (including
`DEPLOY_ENABLED`, `PUBLIC_URL`, `CANONICAL_ORIGIN`, volume mounts) live in
the respective compose files. The scripts only rewrite the `image:` line
— they never touch env vars.

Each deploy script has its own deploy key and its own forced-command
entry in `~/.ssh/authorized_keys` on AX41:

```
command="/usr/local/sbin/floom-deploy-preview.sh",no-pty,no-agent-forwarding,no-port-forwarding,no-X11-forwarding ssh-ed25519 AAAA...preview... floom-auto-deploy-preview
command="/usr/local/sbin/floom-deploy-prod.sh $SSH_ORIGINAL_COMMAND",no-pty,no-agent-forwarding,no-port-forwarding,no-X11-forwarding ssh-ed25519 AAAA...prod... floom-auto-deploy-prod
```

The prod entry uses `$SSH_ORIGINAL_COMMAND` so the GitHub Actions client
can pass the image tag as its requested command. The script
regex-validates the argument before using it, so the passthrough is
safe.

GitHub repository secrets used:

- `AX41_HOST`, `AX41_USER`: shared between the two workflows
- `AX41_DEPLOY_KEY`: preview deploy key (private half)
- `AX41_PROD_DEPLOY_KEY`: prod deploy key (private half) — **add this
  one**: it is new with this PR and must be created alongside a new
  `authorized_keys` entry on AX41 before the first prod workflow run.

## First-run checklist on AX41

After this PR merges (and auto-runs its final both-container deploy via
the old preview script), one-time setup on AX41:

```bash
# 1. Copy the new scripts into place.
sudo cp /opt/floom-deploy-src/scripts/ops/floom-deploy-preview.sh \
        /usr/local/sbin/floom-deploy-preview.sh
sudo cp /opt/floom-deploy-src/scripts/ops/floom-deploy-prod.sh \
        /usr/local/sbin/floom-deploy-prod.sh
sudo chmod +x /usr/local/sbin/floom-deploy-preview.sh
sudo chmod +x /usr/local/sbin/floom-deploy-prod.sh

# 2. Generate the prod deploy key.
ssh-keygen -t ed25519 -f ~/.ssh/floom-auto-deploy-prod \
           -C floom-auto-deploy-prod -N ''

# 3. Add the forced-command line to authorized_keys (see snippet above).

# 4. Put the private key into the GH secret AX41_PROD_DEPLOY_KEY
#    (gh secret set AX41_PROD_DEPLOY_KEY < ~/.ssh/floom-auto-deploy-prod).

# 5. Touch the log file so the first run does not fail on exec-append.
sudo touch /var/log/floom-deploy-prod.log
sudo chown "$USER":"$USER" /var/log/floom-deploy-prod.log
```

After that, the first prod deploy under the new regime is a manual
`workflow_dispatch` on the `Deploy prod` workflow.

## How to update either script

The repo copy is the source of truth.

1. Edit `scripts/ops/floom-deploy-preview.sh` or
   `scripts/ops/floom-deploy-prod.sh` in this repo.
2. Open a PR, get it reviewed, merge to `main`.
3. On AX41, copy the updated script into place (same `cp` invocations
   as the first-run checklist above).
4. For preview: trigger a deploy via `workflow_dispatch` on the
   `Deploy preview` workflow, or wait for the next push to `main`.
5. For prod: trigger `workflow_dispatch` on the `Deploy prod` workflow.

## Why these files are checked in

The scripts are system-level infra, not part of the app bundle. Keeping
them in the repo:

- gives them reviewable history (every change goes through PR);
- prevents the kind of drift that caused the 2026-04-24 incident, where
  `preview.floom.dev` ran stale code for ~1 hour because the deploy hook
  only touched prod;
- enforces the 4-step ship workflow by construction (preview auto + prod
  manual, separate scripts, separate keys);
- makes it obvious to anyone reading the codebase how deploys actually
  work.
