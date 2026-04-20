# pd-03 — Path 2 Docker: operator vs ICP tension

**Track:** `pd-03`  
**Scope:** Deployment path 2 (“Docker → hosted”), host requirements from `docs/PRODUCT.md`, and the execution stack in `apps/server/src/services/{docker,runner,seed}.ts` plus `apps/server/src/lib/entrypoint.{mjs,py}`.  
**Out of scope:** Path 3 OpenAPI-only proxied ingest (except where the same runner branches on `app_type`).

---

## 1. Executive read

`docs/PRODUCT.md` draws a clean line: **`git` and `docker` are operator-side** on the machine that runs the Floom server process. The ICP should only ever see the **three surfaces** (web form, MCP, HTTP). Path 2 is explicitly **“second class”** and is the **internal hosted execution layer** that path 1 also plugs into.

The tension in the current tree is not “Docker exists” (it must, for hosted runs) but **where Docker vocabulary and operator controls leak into creator/end-user surfaces**: marketing hero copy, protocol/README examples, persisted `run.error` strings exposed under “Show details,” and README/manifest examples that describe a `build`/`run` hosted shape that does not match the Dockerfile+entrypoint injection model in `docker.ts`.

---

## 2. Truth table (who must know what)

| Dimension | Cloud ICP (floom.dev style) | Self-host operator (process on host) | Self-host operator (Floom **inside** a container) |
|-----------|----------------------------|----------------------------------------|---------------------------------------------------|
| **Must understand Docker as a product concept** | No — paste repo / use surfaces | Yes — daemon on host, images, optional socket for seed | Yes — and must understand **PRODUCT’s unsupported matrix** for path 1 from inside the container |
| **Must set operator env (`RUNNER_*`, `FLOOM_SEED_APPS`)** | Platform team | Yes, if tuning memory/CPU/timeout or opting into seed | Same; **plus** socket mount is a security/trust decision (`seed.ts` warns) |
| **Must author `apps.yaml` with `type: hosted`** | Uncommon for ICP | Yes for path 2 registration | Yes; still no path-1-from-container per PRODUCT |
| **Sees Docker in primary UI headlines** | Mostly no (taxonomy hides it) | Same web app | Same |
| **Can see Docker/container words in expandable run details** | Yes — raw `run.error` and logs | Yes | Yes |
| **Path 1 (repo → clone/build/run) viable** | Yes (operator host) | Yes if `git`+`docker` on host | **No** — PRODUCT: no host socket into Floom container, no DinD |

**Legend:** “ICP” = non-developer AI engineer using hosted Floom; “operator” = whoever runs the server binary or container image.

---

## 3. Code ↔ product mapping (public surfaces)

### 3.1 `docker.ts` (skim + deep)

- **Role:** `dockerode` client; builds per-app images (`buildAppImage`), runs one-shot containers (`runAppContainer`), removes images (`removeAppImage`).
- **Operator-only knobs (env):** `BUILD_TIMEOUT`, `RUNNER_TIMEOUT`, `RUNNER_MEMORY`, `RUNNER_CPUS`, `RUNNER_NETWORK` — no UI; correct per PRODUCT.
- **ICP-adjacent risk:** `runAppContainer` throws a user-facing string on missing image: *`This app's container image "<tag>" isn't available on this Floom instance. The app creator needs to publish it.`* — classified upstream as `app_unavailable`, but the **full string is still persisted** and appears under **Show details** in `OutputPanel.tsx` (raw `run.error`). Headline path uses neutral copy (`buildAppUnavailable`).
- **Implementation detail:** Generates a `Dockerfile` and copies `_entrypoint.{mjs,py}`; not something the ICP authors by hand on the paste-repo path.

### 3.2 `runner.ts` (skim + deep)

- **Role:** Secret merge + `dispatchRun` → `runAppContainer` (hosted) vs `runProxied` (OpenAPI).
- **Operator vocabulary in persisted errors:**
  - OOM path: **`Container ran out of memory. Increase RUNNER_MEMORY.`** — tells end users to change an env var only operators control; UI headline softens to “Floom-side limit” but **details still leak `RUNNER_MEMORY`**.
  - Unparseable stdout: **`Container exited cleanly but emitted no result`** / **`Container exited with code N`** — “Container” is implementation speak in the stored error and in **Show details**.
- **Positive:** `floom_error_class === 'app_unavailable'` maps to `error_type: 'app_unavailable'` so the card is not `floom_internal_error`.

### 3.3 `seed.ts` (skim + deep)

- **Role:** Optional bundled hub apps from `seed.json`; **default off** (`FLOOM_SEED_APPS` unset → empty hub, log tells operator to use `apps.yaml`).
- **Operator-only logging:** Explicit `/var/run/docker.sock` requirement when seed is on — correct audience (stdout), not the web ICP.
- **Behavioral guard:** Probes Docker for image existence so broken marketplace tags do not land in hub; marks stale rows inactive — protects ICP from a wall of false “Floom broke” runs.

### 3.4 `entrypoint.mjs` / `entrypoint.py`

- **Role:** In-container shim: parse argv JSON, import user app, invoke action, emit `__FLOOM_RESULT__` + JSON.
- **Operator vs ICP:** Docstrings say “floom-docker runner”; **not printed to stdout** by default (only lines like `Importing app module...`). App authors debugging logs may see `[entrypoint]` messages — closer to **creator** than ICP.
- **Note:** Python docstring still says *`argv[1]: JSON`* while Node uses `argv[2]` — internal inconsistency, not ICP-facing.

---

## 4. Messaging audit (Docker vocabulary on surfaces)

| Location | Audience | Docker / infra speak? | Verdict |
|----------|----------|----------------------|---------|
| `docs/PRODUCT.md` — “Host requirements” | Operator | Explicit `git`/`docker`, in-container unsupported | **Aligned** |
| `docs/SELF_HOST.md`, `docker/docker-compose.yml` | Operator | Socket, `FLOOM_SEED_APPS` | **Aligned** |
| `apps/web/src/components/home/WhyFloom.tsx` | ICP | Avoids Docker in visible copy (comment only) | **Aligned** |
| `apps/web/src/pages/CreatorHeroPage.tsx` — self-host block | Mixed (“open-source-first”) | **`docker run -p 3010:3010 floomhq/floom`** + “**14 apps ready**” | **Tension:** hero implies one command yields a populated hub; default seed is **off** (`seed.ts`), compose defaults **proxied-only** unless operator opts in + mounts socket. ICP-skimming may believe “no Docker knowledge” conflicts with “one line” being a Docker command. |
| `apps/web/src/assets/protocol.md`, `README.md` | Creator / operator | “**Via Docker**”, “v1 runs **Docker** everywhere”, README “**Floom runs your container**” | **Leak toward creator:** positions Docker as the runtime story for everyone, not only operators. |
| `apps/web/src/pages/BuildPage.tsx` | Creator | “Import from a **Docker image**” (coming soon) | Acceptable if framed as **advanced**; still trains “Docker = Floom import” mental model. |
| `apps/web/src/pages/InstallPage.tsx` | Operator-ish | “Docker compose + environment” | **Aligned** |
| `apps/web/src/pages/ProtocolPage.tsx` | Technical reader | `docker run ...` example | **Operator / integrator** |
| `apps/web/src/components/runner/OutputPanel.tsx` | ICP + creators | Headlines mostly neutral; **Show details** = raw `run.error` | **Leak on expand:** `RUNNER_MEMORY`, “container image”, “Container exited…” |
| `apps/web/src/pages/TermsPage.tsx` | Legal | “container images” | Neutral legal term |

---

## 5. Failure modes — self-hoster runs Floom **in** a container (PRODUCT: unsupported for path 1)

PRODUCT states: no host Docker socket mounted into Floom’s container; Docker-in-Docker not configured; **do not expect path 1** from that topology.

| Failure mode | What happens | Who feels it | Copy / support risk |
|--------------|--------------|----------------|---------------------|
| No Docker socket / daemon unreachable | `dockerImageExists` → false; seed apps skipped; `buildAppImage` / `runAppContainer` fail at runtime | Operator | Logs reference Docker; ICP may see generic run failures if any hosted app is registered |
| Operator enables `FLOOM_SEED_APPS` without socket | Seed warns; image probe fails; apps skipped or empty hub | Operator | Console-only today |
| Hosted app row references external `docker_image` tag not on host | `app_unavailable` + message mentions **container image** | End user | Headline OK; details technical |
| OOM in child app container | `error_type: 'oom'`, message mentions **`RUNNER_MEMORY`** | End user | Headline blames “Floom-side limit”; details instruct env tweak → **ICP dead-end** |
| Path 1 attempted from in-container Floom | Clone/build cannot use host Docker as PRODUCT defines | Operator | Easy to misread as “Floom bug” if marketing says “paste repo” without topology caveat |
| “Same as cloud” expectation | `protocol.md`: “Same runtime on cloud and self-host” | Operator | True at a high level; **false** if they mean “any compose layout works for repo deploy” |

---

## 6. Risk register

| ID | Risk | Severity | Mitigation direction (product, not code in this audit) |
|----|------|----------|----------------------------------------------------------|
| R1 | **ICP expands “Show details”** and reads operator instructions (`RUNNER_MEMORY`, container exit codes) | Medium | Separate operator diagnostics from user-visible error channel, or sanitize persisted `run.error` for non-admin sessions |
| R2 | **Marketing / protocol drift:** README `build`/`run` hosted example vs actual **generated Dockerfile + entrypoint** path in `docker.ts` | Medium | Single story for “hosted” in docs: either aspirational spec is labeled **future**, or implementation is described accurately |
| R3 | **CreatorHero “14 apps ready”** vs **empty hub by default** | Medium | Align number + prerequisite (seed + socket) or rephrase (“up to N demo apps when enabled”) |
| R4 | **`protocol.md` “Docker everywhere”** read by ICP as “I must learn Docker” | Medium | Reframe v1 execution as “Floom runs apps in isolation” with Docker as **implementation detail** footnote for self-hosters |
| R5 | **In-container self-host** + paste-repo expectation | High | PRODUCT is clear; **onboarding** (install docs, hero) should repeat the unsupported matrix in one plain sentence |
| R6 | **Entrypoint comments** “floom-docker runner” | Low | Dev-only; optional rename to “hosted runner” in comments if it reduces confusion in OSS readers |

---

## 7. PM questions

1. **Should any non-operator session ever see raw server `run.error` strings**, or should the web UI show a stable, persona-scoped message with a separate “copy technical details” for owners?
2. **Is CreatorHero’s self-host block aimed at the ICP or at integrators?** If both, do we need two columns: “Use floom.dev” vs “Run on your server”?
3. **What is the single sentence for v1** that is true for cloud **and** self-host **and** in-container Floom without sounding like “Docker is your problem”?
4. **Hosted manifest story:** Is the README/protocol `build`/`run` block the north star, or is the current `docker.ts` codegen the source of truth until v1.1?
5. **Seed hub count (“14 apps”)** — what is the canonical number and condition list (fast apps vs seeded docker apps vs `apps.yaml`)?
6. **For `app_unavailable` caused by missing image**, do we want the sub-headline to hint “this Floom server doesn’t have the app package” without saying **Docker**, or is neutral “creator / operator” wording enough?
7. **OOM remediation:** Should the product ever tell an **end user** to “report” vs tell an **app owner** to “reduce memory” vs **only operators** see `RUNNER_MEMORY`?

---

## 8. References (load-bearing)

- `docs/PRODUCT.md` — ICP, path 2, host requirements (in-container + path 1).
- `apps/server/src/services/docker.ts` — image build/run, missing-image guard.
- `apps/server/src/services/runner.ts` — dispatch, OOM/copy, container exit messages.
- `apps/server/src/services/seed.ts` — `FLOOM_SEED_APPS`, socket note, image probe.
- `apps/server/src/lib/entrypoint.mjs`, `entrypoint.py` — in-container protocol.
- `apps/web/src/components/runner/OutputPanel.tsx` — error taxonomy + raw detail leak.
- `apps/web/src/pages/CreatorHeroPage.tsx` — `docker run` hero line.
- `apps/web/src/assets/protocol.md`, `README.md` — Docker-forward framing.

---

*Audit artifact only; no code changes in the pd-03 pass.*
