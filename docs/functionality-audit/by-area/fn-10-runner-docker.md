# Backend audit: Docker runner (`services/runner.ts`, `services/docker.ts`)

**Scope:** Hosted (`type: hosted`) execution path: secret merge and dispatch in `runner.ts`; container create/start/wait/teardown and image build helpers in `docker.ts`. Proxied apps use `proxied-runner.ts` (referenced only where paths diverge).

**Product alignment:** Per `docs/PRODUCT.md`, `apps/server/src/services/docker.ts`, `runner.ts`, and `seed.ts` are load-bearing for **Docker → hosted** (path 2) and as the execution layer repo→hosted can plug into. End-user surfaces stay web form (`/p/:slug`), MCP, and HTTP (`/api/:slug/run`); this stack implements **how** hosted runs execute on the operator host.

---

## Container lifecycle (`docker.ts` → `runAppContainer`)

**Flow**

1. **Resolve image:** `opts.image`, else `apps.docker_image` from SQLite, else tag `floom-chat-app-${appId}:latest` (`imageTag`).
2. **Create** container named `floom-chat-run-${runId}`, `Cmd` = single JSON string `{ action, inputs }`, `Env` built from merged secrets (see below).
3. **Attach** stdout/stderr before **start**, demux into PassThrough collectors; optional `onOutput` callback per chunk.
4. **Start**, then **`Promise.race`** between `container.wait()` and a timer (`timeoutMs`, default `RUNNER_TIMEOUT`).
5. **On timer win:** set `timedOut`, **`container.kill()`** (errors swallowed), **no await** of the outstanding `wait()` promise.
6. **Pause** `50ms`, then **`container.inspect()`** for `ExitCode` and `OOMKilled` (failures ignored if container vanished).
7. **`container.remove({ force: true })`** — best-effort; `AutoRemove` is **false**, so cleanup is entirely this explicit remove.

**Strengths**

- One-shot runs with deterministic naming (`runId` in container name) aid ops grep.
- Timeout path attempts kill before inspect/remove so zombies are less likely.
- OOM surfaced via Docker state, not only exit codes.

**Risks**

- **`wait()` is not awaited after `kill()`**, so the race promise may settle later with no consumer; usually harmless but can surface as lingering Docker events under load.
- **`inspect` after kill + fixed 50ms delay** is heuristic; very slow daemons might still race rarely.
- **Streams:** attach is opened before start (correct for dockerode); large stdout without backpressure tuning could memory-pressure the Node process (chunks accumulate in arrays until completion).

---

## Resource limits

| Knob | Env / default | Applied where |
|------|----------------|---------------|
| Run wall-clock | `RUNNER_TIMEOUT` → **300_000 ms** | `setTimeout` race vs `container.wait()` |
| Build wall-clock | `BUILD_TIMEOUT` → **600_000 ms** | `buildAppImage` only |
| Memory cap | `RUNNER_MEMORY` → **`512m`** | `HostConfig.Memory` (+ `MemorySwap` set equal to disable extra swap vs RAM) |
| CPU cap | `RUNNER_CPUS` → **1** | `NanoCpus = floor(cpus * 1e9)` |
| Network | `RUNNER_NETWORK` → **`bridge`** | `NetworkMode` |

**Parsing:** `parseMemory` accepts `^\d+[kmg]?$` (case-insensitive); **malformed values silently fall back to 512 MiB**.

**Per-run overrides:** `runAppContainer` accepts optional `timeoutMs`, `memory`, `cpus`, `network`; **`runner.ts` does not pass them**, so deployments rely on env globals unless another caller appears.

**Scope:** Limits apply to **user workload containers**, not to the Floom Node process itself.

---

## Error mapping → `floom_internal_error` (`runner.ts`)

Server taxonomy (`apps/server/src/types.ts`) lists **`floom_internal_error`** for Floom-side failures including runner/build issues. **`runner.ts` assigns `error_type: 'floom_internal_error'` when:**

| Situation | `status` | Other `error_type` notes |
|-----------|----------|---------------------------|
| **`runActionWorker` throws** (Docker API error, unexpected exception) | `error` | — |
| **No parsable entrypoint JSON** after run, **or** non-zero exit without a structured `ok` result | `error` | Distinct from entrypoint-declared failures |
| **Exit 0 but no result marker / JSON** (“Container exited cleanly but emitted no result”) | `error` | Treats protocol violation as Floom/container contract failure |

**Not `floom_internal_error` (hosted path):**

| Situation | `error_type` |
|-----------|----------------|
| Wall-clock kill | `timeout` (`status`: `timeout`) |
| Docker `OOMKilled` | **`oom`** (message suggests raising `RUNNER_MEMORY`) |
| Entrypoint returns `ok: false` | **`parsed.error_type` or `runtime_error`** |
| Entrypoint `ok: true` but `detectSilentError` finds embedded failure | `runtime_error` |
| **`runProxied` throws** (proxied runner crash) | `floom_internal_error` |

**Comment drift:** `types.ts` prose groups “OOM” with `floom_internal_error`; **hosted runs persist `oom`**, not `floom_internal_error`. Client UI may still map `oom` for display (see web types).

---

## Secret injection (`runner.ts` → `docker.ts`)

**Merge order (documented in `dispatchRun`):** global secrets (`app_id IS NULL`) → per-app secrets → creator overrides (`creator_override` policy, via `app_creator_secrets`) → user vault keys (`user_vault`) → **`perCallSecrets` (MCP) wins last**.

**Injection surface:** Only keys listed in **`manifest.secrets_needed`** are copied into the object passed to **`runAppContainer`**. Missing keys are simply absent (no automatic `missing_secret` classification at dispatch for Docker—detection is effectively at app/runtime unless another layer adds it).

**Docker encoding:** `Env` is `key=value` strings from `Object.entries(opts.secrets)`. Values are **not shell-escaped** beyond JSON inputs living in `Cmd`; secret values containing **`=` or newlines** could theoretically break env parsing—unusual but worth knowing for binary-ish tokens.

**Failure handling:** Creator and user vault load failures **`console.warn`** and continue (partial secrets). That matches “admin secrets still run” intent but can produce **silent partial injection** if only vault keys were required.

---

## Build failures (`docker.ts`)

**`buildAppImage(appId, codeDir, manifest)`**

- Writes **`Dockerfile`** + copies **`_entrypoint.{py,mjs}`** from `services/../lib/` (dist- or src-relative candidates).
- **Python:** `python:3.12-slim`, optional `apt_packages` (sanitized charset), `pip install` for `python_dependencies`, entrypoint `python /app/_entrypoint.py`.
- **Node:** `node:22-slim`, conditional `npm install --omit=dev`, entrypoint `node --experimental-strip-types /app/_entrypoint.mjs`.
- **`docker.buildImage`** with `followProgress`; failures become **rejected `Error`** (stream error message or `'Build failed'`).
- **`BUILD_TIMEOUT`** rejects with **`Build timed out after ${BUILD_TIMEOUT}ms`**.

**Integration gap:** As of this audit, **`buildAppImage` / `removeAppImage` are not referenced** by other modules under `apps/server` (only defined/exported in `docker.ts`). **`runAppContainer` does not invoke a build**; it assumes the image already exists (`docker_image` or default tag). So **build failures are not mapped to run rows or `floom_internal_error` anywhere in-repo until a caller wires `buildAppImage` into deploy/ingest.** Repo→hosted work (`packages/runtime`, future `/api/deploy-github`) is expected to attach here per `PRODUCT.md` / roadmap.

---

## Summary

| Area | Assessment |
|------|------------|
| **Lifecycle** | Create → attach → start → race wait/timeout → kill on timeout → inspect → force remove; practical for single-host Docker. Minor concern: orphaned `wait()` after kill. |
| **Limits** | Memory/CPU/network/time enforced on the container; defaults operator-tunable via env; no per-app tuning from DB in current `runner` call. |
| **`floom_internal_error`** | Used for runner crashes, missing/invalid entrypoint protocol output, and proxied-runner crashes—not for user timeouts, OOM (`oom`), or honest entrypoint `runtime_error`. |
| **Secrets** | Layered merge + manifest filter + Docker env; vault load failures are non-fatal warns. |
| **Build** | Robust Dockerfile generation and progress parsing, but **build path is not wired** to HTTP/MCP ingest in this codebase snapshot; **`runner` runtime path is run-only.**
