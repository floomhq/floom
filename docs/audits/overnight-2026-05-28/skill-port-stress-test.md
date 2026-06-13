# Skill Port Stress Test — OpenDraft + OpenBlog

Date: 2026-05-28 (overnight)
Approach: manual-shim port (Codex Q2 verdict).
Status: both workers PORTED, LOAD, RUN, and COMPLETE. Two pre-existing runtime quirks surfaced and are documented below.

---

## 1. Per-skill investigation

### 1.1 OpenDraft (federicodeponte/opendraft)

**Original structure.** Full Python engine, MIT-licensed.

- Self-described as "19 specialized AI agents" across research, structure, writing, citation, polish, and export phases.
- CLI entrypoints: `generate_theses.py`, `generate_housing_thesis.py`, `generate_accelerator_thesis.py`, `engine/draft_generator.py`, plus a subcommand-style `opendraft tldr` and `opendraft digest`.
- Sources cited from CrossRef, OpenAlex, Semantic Scholar (200M+), arXiv via HTTP APIs.
- Multi-LLM: anthropic, openai, google-genai (Gemini).
- Export: weasyprint (PDF, no LaTeX), python-docx, raw LaTeX. weasyprint pulls native libs (cairo, pango, gdk-pixbuf).
- Typical runtime: 10–20 minutes, 5–80 pages, 10k–20k words.
- Hosted alternative: https://example.com.
- No SKILL.md upstream. CLI-shaped.

**Inputs (upstream).** Topic, level, citation style, length, language, model choice. Most are CLI flags.

**Outputs (upstream).** PDF, DOCX, LaTeX, JSON metadata, bibliography.

**External deps.** CrossRef API, OpenAlex API, Semantic Scholar API, arXiv API, Anthropic, OpenAI, Gemini, optional ElevenLabs (for `digest` audio), optional GPTZero. Heavy native deps: weasyprint.

**Tools/MCPs.** None. Standalone CLI/library.

**Why it does NOT fit E2B as-is.**

1. Runtime: 10–20 min vs `timeout_seconds: 300` cap.
2. Deps: weasyprint needs native cairo/pango/gdk-pixbuf — not installable in the E2B Python311 template by `pip install` alone (system packages).
3. Multi-LLM client setup: secrets for Anthropic + OpenAI + Gemini all required.
4. 200M-paper citation calls would amplify network egress beyond the typical sandbox profile.
5. The agent runtime exposes no live web search, so `CrossRef`/`OpenAlex`/`arXiv` lookups would have to be re-implemented as agent-driven HTTP fetches (currently not surfaced).

### 1.2 OpenBlog (federicodeponte/openblog → scailetech/openblog)

**Original structure.** 5-stage Gemini-grounded blog pipeline.

- Stages: Set Context → Blog Gen + Images → Quality Check → URL Verify → Internal Links.
- Per-stage `stageN/` folders with `stage_N.py`, `claude.md` prompt, schema modules, examples.
- Shared layer: `shared/gemini_client.py`, `shared/models.py` (40+ field ArticleOutput), `shared/html_renderer.py`, `shared/article_exporter.py`.
- CLI: `run_pipeline.py --url ... --keywords ... --output ... --export-formats html markdown json csv xlsx pdf`.
- FastAPI server: `api.py` with async jobs, `openapi.json` committed.
- Has a `floom.json` already.
- LLM: Gemini 3 Flash + Imagen for images.

**Inputs (upstream).** Company URL, target keywords (list), language, market, skip_images, export_formats, max_parallel, word_count.

**Outputs (upstream).** Per article: HTML / Markdown / JSON / CSV / XLSX / PDF, plus hero/mid/bottom images.

**External deps.** GEMINI_API_KEY mandatory. `google-genai`, `httpx`, `defusedxml`, `markdownify`, `openpyxl`, `fastapi`, `uvicorn`, `pydantic`. Sitemap crawl needs network access to the user's domain.

**Tools/MCPs.** None directly. Google Search grounding via Gemini.

**Why it does NOT fit E2B as-is.**

1. Image generation via Imagen needs a separate model + API quota.
2. Sitemap fetch happens against the user's live domain; works in principle, but the pipeline expects a full crawl with retries.
3. URL verify stage HEAD-pings every external URL (network egress fine, but unbounded).
4. Multi-format export (xlsx/pdf) needs openpyxl + a PDF renderer (the repo uses Playwright/Chromium in some configurations — Playwright is explicitly listed as a heavy dep in the cookbook).
5. The full 5-stage parallel pipeline runs 10+ minutes for a 5-article batch — exceeds the 300s sandbox timeout.

---

## 2. Port choices (the shim)

Both ports follow the canonical agent-mode pattern from `workers/research_brief/`. Treat each as the **planning / single-pass shim** of its upstream engine, not a re-implementation.

### 2.1 OpenDraft worker — `workers/opendraft/`

- `entrypoint: SKILL.md`, agent mode, `runtime: skill`, `runner: e2b`.
- Manual trigger by default.
- Inputs: `topic` (string), `level` (undergrad/masters/phd), `length_target` (10/30/60/100 pages), `language` (en/de/es/fr).
- Output: single `out/outline.md` (markdown, required).
- `capabilities.secrets: []` — no provider key required (the agent runtime's underlying model does the inference).
- `capabilities.network.egress: true` — kept on for any future web-fetch tooling.
- Limits: 12 tool iterations, 6144 output tokens, 60000 total tokens, 300s timeout.
- `requirements.txt`: empty (agent mode), but documents upstream pinned versions for posterity.
- Deviation from upstream: this shim does NOT call CrossRef/OpenAlex/Semantic Scholar/arXiv. The SKILL.md explicitly forbids fabricating citations and instead instructs the agent to describe the TYPE of source per section. The user is told the full engine is at https://github.com/federicodeponte/opendraft for the long-form pipeline.

### 2.2 OpenBlog worker — `workers/openblog/`

- Same shape: agent mode, `runtime: skill`, `runner: e2b`, manual trigger.
- Inputs: `topic`, `target_keyword`, `audience` (5 options), `word_count` ("800"/"1500"/"2500"), `format` (article/listicle/guide/comparison).
- Output: single `out/draft.md`.
- `capabilities.secrets: []`. `capabilities.network.egress: true`.
- Limits: 12 tool iterations, 8192 output tokens (higher to fit a 2500-word draft), 60000 total tokens, 300s timeout.
- Deviation from upstream: skips Set Context (no sitemap crawl), skips Image Generation (no Imagen), skips URL Verify (no HEAD-pinging), skips Internal Links (no real sitemap). The SKILL.md instead asks the agent to describe internal-link opportunities by intent only, and to qualify any time-sensitive claim.

### 2.3 What was NOT copied

- No upstream source files copied into the worker bundles. The shim is a SKILL.md that re-specifies the planning task; it does not import upstream Python.
- `requirements.txt` is intentionally empty (with a comment listing upstream deps for reference) because agent-mode workers don't need a sandbox pip install.

---

## 3. Smoke test results

API host: `https://workers-api.floom.dev` (and `http://127.0.0.1:8011` for sibling checks).
Auth: `x-floom-secret: $(cat /root/workeros/.deploy-secret)`.

### 3.1 Worker discovery / load

After dropping the worker folders under `/root/workeros/workers/` and restarting `workeros-api.service`:

```
GET /workers
```

Returned both workers:

```
{"id":"opendraft","status":"healthy","trigger_type":"manual",...}
{"id":"openblog","status":"healthy","trigger_type":"manual",...}
```

Per-worker detail also resolves:

```
GET /workers/opendraft  -> 200, full config
GET /workers/openblog   -> 200, full config
```

### 3.2 Run smoke tests

```
POST /workers/opendraft/runs
  payload: {"inputs":{"topic":"The role of synthetic data in training small language models","level":"masters","length_target":"30_pages","language":"en"},"trigger_source":"manual"}
HTTP/1.1 500 Internal Server Error  (see Section 4)
```

**Despite the 500 response**, the run was created server-side and completed cleanly:

- `run_4095fbd4d914` — completed, 62 316 ms, no error.
- Artifact: `out/outline.md`, 10 790 bytes, real structured outline with thesis, 6 RQs, 8 sections, source-type guidance per section (no fabricated citations).
- Transcript: `outputs/transcript.jsonl`, 27 024 bytes.

```
POST /workers/openblog/runs
  payload: {"inputs":{"topic":"How small recruiting firms in DACH use AI for candidate writeups","target_keyword":"ai candidate writeup tool","audience":"recruiting-operator","word_count":"1500","format":"article"},"trigger_source":"manual"}
HTTP/1.1 500 Internal Server Error  (same as above)
```

Run also completed:

- `run_afb727f83c9f` — completed, 34 160 ms, no error.
- Artifact: `out/draft.md`, 9 781 bytes, real article with TL;DR, 3 H2 sections, H3 sub-blocks, German example prompts (audience: recruiting-operator), internal-link opportunity block, SEO meta block.
- Transcript: 15 807 bytes.

### 3.3 Verdict

| Worker     | Load | Run starts | Run completes | Output produced | Output correct shape |
|------------|------|------------|---------------|-----------------|----------------------|
| opendraft  | PASS | PASS       | PASS (62 s)   | PASS (10.8 KB)  | PASS                 |
| openblog   | PASS | PASS       | PASS (34 s)   | PASS (9.8 KB)   | PASS                 |

Both ports succeed end-to-end.

---

## 4. What broke (and why)

### 4.1 POST /workers/.../runs returns 500 despite the run completing successfully

**Symptom.** Every `POST /workers/<id>/runs` returns HTTP 500 with `{"detail":"Internal server error"}`, but the run is created in the DB, executes in the sandbox, and lands its artifacts on disk.

**Root cause.** Starlette middleware `_utils.collapse_excgroups` raises `RuntimeError: Unexpected message received: http.request` after the response is sent. Trace shows the bug originates in the `request_body_size_middleware` at `apps/api/main.py:303-307`, which replaces `request._receive` with a one-shot, then downstream middleware (`security_headers_middleware`, `rate_limit_middleware`, `auth_middleware`, all `BaseHTTPMiddleware`-style) tries to read `receive()` a second time (during disconnect listening) and trips the assertion.

**Impact for this port.** The runs still complete. The 500 is purely a response-shape regression — a client that retries on 500 will create duplicate runs. The web UI (which uses fetch + retries) is likely tracking this issue under existing audits.

**Scope note.** Out of scope per the brief ("Do NOT modify apps/api/main.py"). Flagged here as the highest-leverage runtime fix because it makes every worker invocation look like a failure to API callers.

### 4.2 POST /workers/reload returns 500

**Symptom.** Same middleware failure. Even a hardcoded reload endpoint that returns a tiny JSON dict hits the body-size middleware path because the route is a POST.

**Workaround.** Restart `workeros-api.service`. Workers are re-discovered from `WORKERS_DIR` (`../../workers`) at lifespan startup via `reload_workers()` (`main.py:112`).

### 4.3 YAML quoting trap on `use_cases`

**Symptom.** First version of `opendraft/worker.yml` had:

```
- Compare two framings of the same topic (audience: undergrad vs phd) side by side.
```

YAML parsed `audience:` as a nested mapping key. Pydantic `WorkerContract` then rejected `use_cases.1` as "Input should be a valid string". The worker fell back to status `error` in the registry and was hidden from the public API.

**Fix.** Quoted the line:

```
- "Compare two framings of the same topic (audience: undergrad vs phd) side by side."
```

**Failure mode for non-developers.** A non-developer authoring `use_cases:` who happens to drop a colon inside a parenthesis will silently get an `error`-status worker. The registry logs the validation error to journalctl, but the user-facing surface is "worker missing". No surfaced error in the API response or `/workers` listing.

### 4.4 No native heavy deps reached for this stress test

Neither port attempted to bring weasyprint, python-docx, openpyxl, Playwright, or LaTeX into the sandbox. If a user tries to port the full upstream OpenDraft or OpenBlog pipeline literally, they will hit:

- E2B Python311 base image lacks system libs for `weasyprint` (cairo, pango, gdk-pixbuf).
- E2B base image likely lacks Chromium for Playwright PDF export.
- Sandbox install time + size budget is bounded; `torch`/`transformers`-class deps don't fit.

The runtime needs a `runner: local` escape hatch (or a `template_id` selector for heavier E2B templates) before these can be ported literally.

---

## 5. Recommended runtime fixes (in priority order)

1. **Fix `request_body_size_middleware` so POST does not return 500 after success** — `apps/api/main.py:285-307`. Either move it to a starlette `Middleware` class with proper ASGI receive handling, or check the message type before replaying. This is the highest-impact fix because every worker creation, run trigger, secrets-set, and connections call goes through POST.
2. **Surface YAML / Pydantic validation errors in `GET /workers`** — when a worker fails to load, today it disappears silently. Surface it as `status: error` with an `error: "<validation message>"` so the user knows what went wrong. The non-developer path is "worker disappears from list" → unfixable without log access.
3. **Make `/workers/reload` not depend on the broken body-size middleware** — exempt it from the body middleware so it can be called even when POST is otherwise broken, or expose it as a GET (it has no payload).
4. **Add a `template` field in `worker.yml exec.runner` selector** — e.g. `runner: e2b-heavy` that maps to an E2B template image with cairo/pango/playwright/chromium pre-installed. Without this, OpenDraft and OpenBlog full ports are blocked.
5. **Provide a deterministic timeout-vs-iterations guidance in `AUTHORING.md`** — both ports needed `timeout_seconds: 300` and `max_output_tokens: 6144-8192` to fit a longer-form output; nothing in the cookbook recipe section 7 names these numbers for "long-form" work.
6. **Document the `transcript.jsonl` artifact in `AGENT-COOKBOOK.md`** — it shows up alongside declared outputs but is never named in section 8.

---

## 6. User-facing failure-mode walkthrough (non-developer)

A non-developer trying to port their own SKILL.md via the MCP `workers.create` flow today would hit:

1. **`use_cases` colon trap (Section 4.3).** Their worker silently disappears from the list. They get no error in chat. They cannot find it. They give up.
2. **POST 500 (Section 4.1).** Their MCP client may treat the 500 as a hard failure and not poll `/runs?worker_id=...` to see that the run actually completed. They see "create_run failed" and conclude the port is broken when it isn't.
3. **Heavy-deps trap (Section 4.4).** If their upstream skill uses Playwright / weasyprint / LaTeX, the worker installs OK (because requirements.txt isn't sandbox-installed at bundle time) but the first run fails with `ModuleNotFoundError` deep in the sandbox. The error reaches `runs.get` but is buried under "RUN FAILED" with no actionable next step. Cookbook section 7 mentions "won't fit in E2B template — trim or switch to `runner: local`", but `runner: local` is not currently a documented option in `AUTHORING.md` section 3.

If we want non-developers to port skills successfully, fix items 1, 2, and 4 from Section 5. Item 1 alone would have saved this run.

---

## 7. What I changed

```
workers/opendraft/SKILL.md           (new)
workers/opendraft/worker.yml         (new)
workers/opendraft/requirements.txt   (new)
workers/openblog/SKILL.md            (new)
workers/openblog/worker.yml          (new)
workers/openblog/requirements.txt    (new)
docs/audits/overnight-2026-05-28/skill-port-stress-test.md  (this file)
```

No changes to `apps/api/`, `apps/web/`, or any runtime code. Service `workeros-api.service` restarted once to pick up the new worker folders (the `/workers/reload` endpoint is in the broken-POST set and could not be called).

Reference clones used for inspection only (NOT modified, NOT included in commit):

```
/tmp/skills/opendraft
/tmp/skills/openblog
```
