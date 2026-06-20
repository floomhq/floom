# WorkerOS Cloud — AWS (ECS Fargate) deployment runbook

Deploys the cloud API as **two Fargate services** in **`eu-central-1`** (co-located with
Supabase), keeping **Supabase** for DB/auth/storage and **E2B** for sandboxes. This is a
parallel target to Railway (`docs/CLOUD_DEPLOYMENT.md`); it does NOT replace it.

**Why this doc exists:** the first AWS deploy burned ~an hour, almost all of it on a
**wedged local Docker Desktop** (Windows/WSL2 gets stuck on heavy builds). The fix is to
**never build the image on a laptop** — build it on **AWS CodeBuild**. Follow this and a
deploy is ~10 min, off your machine.

---

## 0. Architecture

```
                         ALB (HTTP/80, optional HTTPS via ACM)
                              |
   Fargate svc: workeros-prod-web     Fargate svc: workeros-prod-worker
   WORKEROS_ROLE=web (HTTP only)      WORKEROS_ROLE=worker (drain loop + scheduler)
        |  same image  |                      |  same image  |
        +------------------ ECR: workeros-prod:latest --------+
                              |
        Supabase (DB/auth/storage)   E2B (sandboxes)   Bedrock (LLM, us-east-1)
```

- **One image, two services**, differing only by the `WORKEROS_ROLE` env var (the engine's
  executor split — `engine/apps/api/run_service.py`). No separate entrypoint; both run the
  Dockerfile CMD (`uvicorn apps.api.main:app`).
- **Public-subnet tasks + public IPs, open egress, no NAT gateway** → reach E2B / Gemini /
  Supabase / Bedrock over HTTPS. NAT gateway is the #1 surprise AWS bill; we avoid it.
- **Compute in `eu-central-1`** (== Supabase region; GDPR + low latency). **Bedrock calls
  target `us-east-1`** (125 models vs 38) — compute region and Bedrock region are independent.

## 1. Account / fixed names (account 005696749876)

| Thing | Value |
|---|---|
| Region (compute) | `eu-central-1` |
| ECR repo | `005696749876.dkr.ecr.eu-central-1.amazonaws.com/workeros-prod` |
| ECS cluster | `workeros-prod` |
| Services | `workeros-prod-web`, `workeros-prod-worker` |
| Terraform module | `infra/aws/` (in this repo) |
| CodeBuild project | `workeros-cloud-image` |
| CodeBuild role | `workeros-codebuild-role` |
| Source bucket | `workeros-codebuild-src-005696749876` / `workeros-cloud-src.zip` |

## 2. Prerequisites
- **A deploy-capable AWS identity** (admin, or a role with `ecs/ecr/elbv2/ec2/iam/logs/ssm/s3/codebuild`). The Bedrock-bench key is NOT enough.
- **Terraform** (`terraform.exe`; we keep a copy in `~/.localbin/`). No Docker needed locally — CodeBuild builds.
- **boto3** (`pip install boto3`) for the build orchestration.

## 3. Terraform module (`infra/aws/`)

Files: `providers.tf`, `variables.tf`, `main.tf`, `outputs.tf`, `terraform.tfvars.example`, `.gitignore`.

**Provisions:** ECR repo, CloudWatch log groups, SSM SecureString params (one per secret),
IAM exec + task roles (task role has `bedrock:InvokeModel`), security groups, ALB +
target group + listener(s), ECS cluster, web + worker task defs + services.

### Variables (`variables.tf`)
| var | default | notes |
|---|---|---|
| `region` | `eu-central-1` | keep == Supabase region |
| `app_port` | `8000` | must match the uvicorn bind port |
| `image_tag` | `latest` | ECR tag to deploy |
| `web_cpu`/`web_memory` | `512`/`1024` | Fargate combo |
| `worker_cpu`/`worker_memory` | `1024`/`2048` | |
| `web_desired_count` | `1` | |
| `worker_desired_count` | `1` | the executor-split worker; `0` to disable |
| `web_command` / `worker_command` | `[]` | **leave empty** — role is ENV-driven (`WORKEROS_ROLE`), there is NO `worker_main` entrypoint |
| `container_env` | `{}` | non-secret env (both services). `WORKEROS_ROLE`+`PORT` injected automatically |
| `container_secrets` | `{}` (sensitive) | secret env → SSM SecureString → injected via `valueFrom` |
| `acm_certificate_arn` | `""` | set to add HTTPS listener for `workeros-api.floom.dev` |

### Secrets (`container_secrets`, in gitignored `secrets.auto.tfvars`)
Pull values from `cloud-test-creds.env` + `~/.cloud_db_pass`. Required set:
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`,
`WORKEROS_CLOUD_SECRETS_ENCRYPTION_KEY`,
`WORKEROS_CLOUD_DB_{HOST,PORT,NAME,USER,PASSWORD}` (lock DB — host
`aws-1-eu-central-1.pooler.supabase.com`, port **5432** session-mode, user
`workeros_scheduler.sgizlsyygvlqosgwdimb`), `E2B_API_KEY`, `E2B_API_KEY_FALLBACK`.
`container_env` should set `WORKEROS_MAX_CONCURRENT_RUNS=6`,
`WORKEROS_E2B_PYTHON_TEMPLATE_MEMORY_2048=gzm0071hrus9jwkse7w6`, the warm-pool vars,
`WORKEROS_CLOUD_PROJECT_REF`, `AWS_REGION=us-east-1` (Bedrock).

## 4. Build the image — **on AWS CodeBuild, never on a laptop**

```python
# (run with AWS creds in env; boto3)
# a) zip the build context (Windows path! exclude .git/venv/node_modules/.next/__pycache__/.terraform)
#    -> ~92MB; MUST contain Dockerfile + engine/apps/api/main.py + requirements.txt
# b) upload to s3://workeros-codebuild-src-005696749876/workeros-cloud-src.zip
# c) ensure IAM role workeros-codebuild-role (trust codebuild; policy: logs:*, s3:GetObject on bucket, ecr push)
# d) create/update CodeBuild project workeros-cloud-image:
#      source = S3 (bucket/key) with inline buildspec (ecr login -> docker build -> docker push)
#      environment = LINUX_CONTAINER, aws/codebuild/standard:7.0, BUILD_GENERAL1_LARGE, privilegedMode=true
#      env vars: AWS_DEFAULT_REGION, ECR_REGISTRY, ECR_REPO
#      serviceRole = workeros-codebuild-role
# e) start_build; poll batch_get_builds -> buildStatus SUCCEEDED (~100s on LARGE)
```
The full orchestration is in `~/.localbin/` from the first run (zip+upload+role, then
create-project+start-build, then `cb-watch.sh` polls + applies). Build pushes
`workeros-prod:latest` to ECR; on SUCCEEDED, run apply.

**Buildspec (inline):**
```yaml
version: 0.2
phases:
  pre_build: { commands: [ "aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $ECR_REGISTRY" ] }
  build:     { commands: [ "docker build -t $ECR_REPO:latest ." ] }
  post_build:{ commands: [ "docker push $ECR_REPO:latest" ] }
```

## 5. Apply
```bash
cd infra/aws
terraform init
cp terraform.tfvars.example secrets.auto.tfvars   # fill from cloud-test-creds.env + ~/.cloud_db_pass
terraform apply -auto-approve
curl http://$(terraform output -raw alb_dns_name)/healthz
```
ALB provisioning is the slow step (~3–5 min). Worker has no ALB (drain loop only).

## 6. Verify
- `terraform output alb_dns_name` → `curl .../healthz` should be 200.
- ECS console / `ecs describe-services` → both services `runningCount == desiredCount`.
- CloudWatch log groups `/ecs/workeros-prod/web` + `/ecs/workeros-prod/worker` for boot logs.
- If a task crash-loops on boot: it's a **missing env var** — read the CloudWatch log, add it
  to `container_secrets`/`container_env`, `terraform apply` (re-applies in ~1 min; not a redo).

## 7. Subsequent deploys (~10 min, no laptop Docker)
1. Re-zip + re-upload source to S3 (only if code changed).
2. `start_build` on `workeros-cloud-image`; poll to SUCCEEDED.
3. `terraform apply` (forces new task defs to pull `:latest`). For a code-only change with the
   same tag, bump the task def or use an image digest to force ECS to redeploy.
4. `curl .../healthz`.

(Future: wire CodeBuild→ECR→apply as a single `make deploy-aws` / GitHub Action so it's one command.)

## 8. Gotchas / lessons (don't re-derive)
- **NEVER build on local Docker Desktop (Windows).** It wedges on heavy builds (500s on
  `/_ping`), needs a restart, and burns time. Use CodeBuild. This was the entire reason the
  first deploy took an hour.
- **`for_each` over a `sensitive` map fails** terraform validate ("sensitive values cannot be
  used as for_each arguments"). Fix: `for_each = nonsensitive(toset(keys(var.container_secrets)))`,
  value = `var.container_secrets[each.value]`. (Already fixed in `main.tf`.)
- **`worker_command` must be `[]`** — the engine split is env-driven (`WORKEROS_ROLE`), there is
  no `apps.api.worker_main`. Setting a bogus command crash-loops the worker.
- **Windows path in Python zip:** use `C:\...`, not git-bash `/c/...`, or `os.walk` returns 0 files.
- **No NAT gateway:** tasks run in default-VPC public subnets with `assign_public_ip=true`.
- **Bedrock region ≠ compute region:** compute `eu-central-1`, Bedrock `us-east-1`.
- **Secrets live in SSM SecureString + terraform state** — switch to S3 remote encrypted state
  before team use (uncomment the `backend "s3"` block in `providers.tf`). `secrets.auto.tfvars`
  is gitignored — never commit it.
- **Env completeness:** the cloud needs ~56 env vars, not a handful. Pull the source of truth
  with `railway variables --json` (from the linked prod service) and replicate all of it minus
  `RAILWAY_*`, overriding the **writable-path** vars to container paths under
  `/opt/workeros-cloud/var/` (which the Dockerfile chowns to the `workeros` user):
  `WORKEROS_DB`, `FLOOM_{WORKERS,CONTEXTS,ARTIFACTS}_DIR`, `WORKEROS_GIT_WORKSPACES_DIR`,
  `GOOGLE_APPLICATION_CREDENTIALS`. Default `WORKEROS_DB` is a non-writable relative path
  (`../../data`) → `PermissionError` crash. Note the DB password var is `WORKEROS_CLOUD_DB_PASS`
  (not `..._PASSWORD`).
- **Scheduler advisory lock (key 87452311):** the cloud `lifespan` (`apps/api/main.py`) starts a
  Postgres-advisory-locked scheduler. It was **role-unaware and crashed if the lock was held**
  (another env / rolling deploy). Fixed (this session): `lifespan` now respects `WORKEROS_ROLE`
  (web = HTTP only; worker/all = scheduler+drain) and **skips the scheduler gracefully** instead
  of crashing when the lock is held. This also fixes the Railway rolling-deploy deadlock. So on
  AWS, set `WORKEROS_ROLE=web` (the module does this) and the web boots without fighting Railway's
  lock; the worker runs the drain loop and skips the (Railway-held) scheduler.
- **The deploy key is admin in chat → rotate it** after the deploy.

## 9. Teardown
`terraform destroy` (in `infra/aws/`). Then optionally delete the CodeBuild project, role, and
the source S3 bucket. ECR `force_delete=true` so the repo + images go with destroy.
