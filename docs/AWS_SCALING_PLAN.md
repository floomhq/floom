# AWS Scale-Out Plan — making the WorkerOS Cloud AWS deployment truly scalable

> Status as of this writing: the AWS stack (ECS Fargate, `eu-central-1`, web+worker
> split by `WORKEROS_ROLE`) is a **single-instance parity deployment** — correct, but
> not horizontally scalable. This doc is the sequenced runbook to take it to a
> genuinely scalable stack. It is grounded in the actual code/infra, not generic
> advice. Companion docs: `AWS_DEPLOYMENT.md` (deploy mechanics), `CLOUD_DEPLOYMENT.md`.

## TL;DR — what "truly scalable" means here, and the shape of the work

Two tiers scale very differently:

- **Web/HTTP tier** (`WORKEROS_ROLE=web`): already stateless-friendly — worker code is
  rematerialized from Supabase `_files` per task and the data path is PostgREST/HTTP.
  **Scales horizontally with just an autoscaling policy.** (Done — see Piece 1.)
- **Execution tier** (`WORKEROS_ROLE=worker`): gated by three things that need real work
  before `worker_desired_count > 1` is safe — a **shared concurrency budget**, **shared
  storage** for git-workspaces, and **safe multi-drainer dequeue**. Past that, throughput
  is bounded by **E2B capacity**, not Fargate task count.

You do **not** need a new queue (there's already a Postgres claim-based one) and Redis is
**not** primarily a cache here — its only real jobs are a distributed concurrency counter
and SSE pub/sub fan-out (Pieces 2 and 6).

## Architecture findings that shape this plan (verified in code)

| Finding | File / evidence | Implication |
|---|---|---|
| Concurrency gates are **per-process** `threading.Semaphore` | `engine/apps/api/run_service.py` (`_get_semaphore`, `_get_llm_semaphore`); default `WORKEROS_MAX_CONCURRENT_RUNS=6` | N tasks → 6×N sandboxes → blows past E2B's ~20 hard cap. **Hard blocker to scaling workers.** → Piece 2 |
| Durable queue **already exists** (Postgres, claim-based) | scheduler `claim_schedule_trigger`; run logs `"Queue drain claimed run"` | Don't add SQS/Redis Streams. Lever = safe multi-drainer + autoscale on depth. → Piece 4 |
| Scheduler is a **hard singleton** (PG advisory lock) | `apps/api/cloud_scheduler.py` key `87452311` | Never >1 scheduler. Fine — it's a coordinator; lock gives free failover. Leave as-is. |
| SSE streaming uses an **in-process `part_queue`** | `engine/apps/api/chat_service.py` | A client on task A can't see events from task B. Needs pub/sub once web > 1. → Piece 6 |
| **No EFS / shared volume**; task-local ephemeral disk | `infra/aws/main.tf` (no `aws_efs_*`, no `volume`) | Worker code (Supabase `_files`) + artifacts (Supabase Storage) survive, but **git-workspaces are per-task** and writeback conflicts under >1 worker. → Piece 3 |
| Default VPC, **public subnets**, `assign_public_ip=true`, no NAT | `infra/aws/main.tf` `data.aws_subnets.default` | No private-subnet/multi-AZ HA posture for tasks. → Piece 5 |
| DB lock path uses the **session pooler (5432)**; data path is PostgREST | `cloud_scheduler._dsn()`; `CLOUD_DEPLOYMENT.md` | Wide web fan-out can press the session-pooler connection budget. Keep web on PostgREST + transaction pooler (6543). |

## The plan (tiered, sequenced)

Legend: **Effort** S/M/L · **Risk** = prod blast radius.

### ✅ Piece 1 — Web tier autoscaling — DONE (live)
- **What:** `aws_appautoscaling_target` on the web ECS service, 2–8 tasks, target-tracking on
  CPU 60% and ALB `RequestCountPerTarget` 400/min.
- **Where:** `infra/aws/autoscaling.tf` + vars `web_min_capacity` (2), `web_max_capacity` (8),
  `web_cpu_target`, `web_alb_requests_target` in `variables.tf`.
- **Status:** applied to prod (additive; plan was `3 add, 0 change, 0 destroy`). `min=2` also
  buys AZ HA for the web tier (vs the prior single task).
- **Verify:** `aws application-autoscaling describe-scalable-targets --service-namespace ecs
  --resource-ids service/workeros-prod/workeros-prod-web`.
- **Effort S · Risk none.**

### ⏳ Piece 2 — Distributed concurrency limiter — IMPLEMENTED, in review
The keystone. Replaces the per-process semaphore with a shared budget so the E2B cap holds
across all executor tasks. Without this, scaling workers is unsafe.
- **Engine:** `register_run_limiter(name, limiter)` injection seam — **PR #1768 (merged)**.
- **Cloud:** `apps/api/run_limiter_pg.py` (`PgLeaseLimiter`), migration
  `supabase/migrations/0048_run_concurrency_leases.sql`, gated startup wiring
  (`_install_distributed_run_limiters`), tests `tests/test_run_limiter_pg.py` — **PR #532 (in review)**.
- **Design:** advisory-lock-serialized count+insert into a lease table; TTL-reaped stale leases;
  **fail-open** on DB error (a blip admits the run rather than wedging execution).
- **Flag:** `WORKEROS_RUN_LEASE_ENABLED` (default OFF = engine in-process semaphore, no change).
  `WORKEROS_RUN_LEASE_TTL_SECONDS` (default 1800; **must exceed the longest run**).
- **Rollout (staged):**
  1. Merge #532, deploy with the flag **OFF** (proves the seam bump is inert).
  2. Apply `0048`: `SUPABASE_MANAGEMENT_PAT=… WORKEROS_CLOUD_PROJECT_REF=sgizlsyygvlqosgwdimb
     python scripts/apply_pending_migrations.py --apply`.
  3. Set `WORKEROS_RUN_LEASE_ENABLED=1` on **both** Railway services + the AWS task env.
  4. **Verify:** fire a few runs; `select budget, count(*) from run_concurrency_leases group by 1`
     tracks live slots; logs show no `FAILING OPEN`. Confirm a 7th concurrent run (cap 6) defers.
- **Effort M · Risk low (gated, fail-open).** Open review-asks: fail-open vs closed; TTL vs
  run-timeout coupling. (The engine acquires on the drain thread and releases on the executor
  thread — the limiter's token store is **process-wide, lock-protected, not thread-local**, with a
  cross-thread regression test; an earlier thread-local version leaked leases and was fixed in review.)

### Piece 3 — Shared storage for git-workspaces (EFS)
Makes `worker_desired_count > 1` safe by removing per-task git state.
- **What:** EFS file system + access point + mount the git-workspaces dir into **both** task defs;
  point `WORKEROS_GIT_WORKSPACES_DIR` at the mount. (Worker code = Supabase `_files`; artifacts =
  Supabase Storage already; **git-workspaces** is the unshared bit that corrupts under concurrency.)
- **Terraform (new `infra/aws/efs.tf`):**
  ```hcl
  resource "aws_efs_file_system" "shared" { encrypted = true tags = { Name = "${local.name}-efs" } }
  resource "aws_efs_mount_target" "shared" {
    for_each = toset(local.subnet_ids)
    file_system_id = aws_efs_file_system.shared.id
    subnet_id      = each.value
    security_groups = [aws_security_group.efs.id]   # allow 2049 from the service SG
  }
  resource "aws_efs_access_point" "git" {
    file_system_id = aws_efs_file_system.shared.id
    posix_user { gid = 10001 uid = 10001 }          # matches the task's non-root user
    root_directory { path = "/git-workspaces" creation_info { owner_gid = 10001 owner_uid = 10001 permissions = "0755" } }
  }
  ```
  Then in each `aws_ecs_task_definition`: a `volume { efs_volume_configuration { ... authorization_config { access_point_id = aws_efs_access_point.git.id } } }`
  and a `mountPoints` entry on the container; set `WORKEROS_GIT_WORKSPACES_DIR=/mnt/git-workspaces`.
- **Caveat:** adding a volume/mount **replaces the task definition → rolling service replacement**
  (brief). Plan-gate it. EFS adds latency vs local disk — fine for git clones, watch on hot paths.
- **Alt (no EFS):** back git-workspaces with S3/Supabase and treat local as a cache — more engine
  work, cheaper at rest. EFS is the pragmatic Fargate answer.
- **Verify:** run the same git-backed worker on 2 worker tasks concurrently; no clone/writeback
  corruption; both see the same workspace.
- **Effort M-L · Risk medium (task-def replace).**

### Piece 4 — Queue-depth worker autoscaling
Scale the executor tier on backlog, not CPU.
- **Prereq:** confirm the run dequeue is atomic (`FOR UPDATE SKIP LOCKED` or equivalent claim) so
  multiple drainers can't double-pick a run. (The claim pattern exists — verify before enabling >1.)
- **Metric:** emit queue depth + oldest-queued age to CloudWatch. Two options:
  - a tiny scheduled Lambda that `SELECT count(*) FROM runs WHERE status='queued'` and
    `PutMetricData` (namespace `WorkerOS/Cloud`, metric `QueuedRuns`); or
  - the worker process emits it each drain tick (no extra infra, but only while ≥1 worker runs).
- **Autoscale:** `aws_appautoscaling_target` on `aws_ecs_service.worker` (min 1, max N) + a
  target-tracking policy on `QueuedRuns` per task (or a step policy: +1 task per K queued).
- **Order:** ship **after** Pieces 2 + 3 (shared budget + shared storage) — otherwise scaling
  workers over-admits sandboxes and corrupts git state.
- **Effort M · Risk low (additive once 2+3 land).**

### Piece 5 — Multi-AZ networking (private subnets + NAT)
HA + a real network posture for the tasks.
- **What:** dedicated VPC (or carve private subnets in ≥2 AZs) + NAT gateway(s); move ECS tasks
  into private subnets (`assign_public_ip=false`); ALB stays public across the AZ subnets; tasks
  egress to E2B/Gemini/Supabase/Bedrock via NAT.
- **Why it's risky:** this **rearchitects the live VPC** the running services sit in — a bad apply
  can sever them mid-rollout, and the Terraform state is **local** (`infra/aws/terraform.tfstate`,
  no S3 backend/locking). **Do this one plan-gated, off-hours, ideally after moving state to a
  remote backend** (`s3` + `dynamodb` lock — see Piece 0 below).
- **Cost:** NAT gateway(s) ~ $32/mo each + data. Per-AZ NAT for true HA.
- **Effort M · Risk HIGH (live VPC).**

### Piece 6 — ElastiCache + SSE pub/sub fan-out
Live run/chat streaming across a scaled web tier.
- **What:** `aws_elasticache_replication_group` (Redis); replace the in-process `part_queue` in
  `chat_service.py` (and run-watch) with Redis pub/sub (or Postgres `LISTEN/NOTIFY` to avoid new
  infra) so a client's SSE connection on any web task receives events produced elsewhere.
- **Note:** this is a **real engine refactor** (multi-day), not config — `chat_service.py` and the
  run-streaming path. If Redis is already standing up here, it can *also* back the Piece 2 limiter
  (one fewer Postgres dependency) — decide jointly.
- **Effort L · Risk high (engine refactor + new infra).**

### Piece 0 (do early) — Remote Terraform state
Before any disruptive apply (Pieces 3/5), move state off the local file:
- `s3` backend bucket (versioned, encrypted) + `dynamodb` lock table; `terraform init -migrate-state`.
- Removes the "local, unlocked state" hazard and lets CI/others apply safely.
- **Effort S · Risk low (one-time migration).**

## The real ceiling: E2B capacity (not Fargate count)
Execution runs in E2B sandboxes off-box, so scaling Fargate tasks without E2B headroom just
deepens the queue. Levers (largely already wired):
- Warm pool: `WORKEROS_E2B_WARM_POOL_ENABLED/SIZE_PER_KEY/MAX_AGE_SECONDS`.
- Multiple E2B accounts/keys via the **LiteLLM gateway virtual keys** to raise the global cap; the
  Piece 2 limiter's budget should track the **aggregate** E2B capacity.
- Baked templates (`WORKEROS_E2B_PYTHON_DEPS_BAKED`, template-memory vars) for fast cold start.

## Recommended execution order
1. **Piece 0** (remote state) — unblocks safe applies. *(early, cheap)*
2. **Piece 2** (limiter) — merge #532, staged flag rollout. *(keystone)*
3. **Piece 3** (EFS git-workspaces) — plan-gated task-def replace.
4. **Piece 4** (queue-depth worker autoscaling) — only after 2+3.
5. **Piece 5** (multi-AZ) — plan-gated, off-hours, after Piece 0.
6. **Piece 6** (Redis + SSE pub/sub) — when live multi-task streaming is needed.

## Apply discipline (carry-over from the deploy runbook)
- Additive/reversible changes (autoscaling, EFS/Redis *resources*) → apply, verify.
- Service-replacing or VPC-touching changes (mounts, networking) → **`terraform plan`, paste the
  `add/change/destroy` summary, get sign-off, apply off-hours.**
- After **every** deploy: `scripts/apply_pending_migrations.py --dry-run` (migrations are a
  separate manual step — `railway up`/`ecs deploy` do **not** run them) and `bash ops/smoke-routes.sh`.
- Rotate the exposed creds (AWS admin key, Supabase PAT, Railway project token) — see session notes.

## Open decisions to settle as you review
- **Piece 2:** fail-open vs fail-closed; TTL fixed vs tied to run-timeout.
- **Piece 3 vs 6:** EFS-only, or stand up Redis (Piece 6) and also use it for the Piece 2 limiter?
- **Piece 5:** dedicated VPC vs private subnets in the default VPC; per-AZ NAT (HA, costlier) vs single.
- **Budget source of truth:** wire the limiter cap to the *aggregate* E2B account capacity, not a
  static 6.
