# Codex Architecture Consult — 2026-05-28

**Subject:** 4 architecture decisions for Workeros (MCP suggestions data model, claude-skill port path, /runs/<id> full logs UI, async /workers/drafts).
**Dispatcher:** Claude (Workeros UI lane).
**Codex session id:** `019e6b57-e32d-7242-821e-e42e9446d049`
**Codex model:** `gpt-5.4` @ medium reasoning.
**Reason:** the operator delegated these to Codex per the standing rule "code/implementation/merge questions go to Codex, not the operator" (MEMORY.md 2026-05-25).

> Note: a first dispatch at `xhigh` reasoning ran out of turn budget mid-investigation (Codex burned the turn budget on doc reads). This run was re-dispatched with `medium` reasoning + a "decide from prompt context only, no file reads" directive. Verdicts below come from that second run.

---

## Prompt sent to Codex

The full prompt is preserved at `/tmp/codex-consult-prompt-v2.txt`. Summary: 4 questions, each with 2-3 lettered options, output format `Pick / Why / Next step` per question, under 800 words total.

Context provided in-prompt (no file reads required): Workeros tech stack, DB tables (connections / secrets / workers / runs / run_logs / run_parts), auth (x-floom-secret), R8 audit findings (14/48 endpoints 500, OpenAPI leaks docs, /workers/drafts 500), /runs/<id> SSE parts and Tool truncation.

---

## Codex verdicts

### Question 1 — MCP suggestions data model

- **Pick:** (a) `{npm_package, env_vars: string[]}` flat
- **Why:** V0, single-user, header auth, and a connections-page suggestion list do not justify a new relational model. MCPs here are install suggestions plus env requirements, not first-class authenticated resources; forcing them into `connections` muddies the meaning of that table and (b) is premature schema weight.
- **Next step:** Add a hardcoded suggestion registry in the API layer that returns `{npm_package, env_vars}` for the `/connections` MCP tab.

### Question 2 — Claude-skill port path (opendraft, openblog) tonight

- **Pick:** (a) Manual shim
- **Why:** Tonight's goal is stress-testing two real skills, not inventing the permanent abstraction. Manual shims give you the fastest proof of the operator's wedge without touching runtime semantics; if the wedge fails, you have not overbuilt an adapter or CLI around the wrong contract.
- **Next step:** Create `workers/opendraft/worker.yml` and `workers/openblog/worker.yml` as hand-written shims pointing at the imported skill content.

### Question 3 — Full agent logs UI on /runs/<id>

- **Pick:** (c) Both — un-truncate Tool inputs/outputs AND add a Raw tab + JSON download
- **Why:** Un-truncating the existing Tool card fixes the immediate debugging pain, but it still leaves no canonical full-fidelity view of the run. A Raw tab plus JSON download makes the page operationally complete for agent runs, and the un-truncated Tool view preserves fast local inspection without forcing users into a dump view.
- **Next step:** Update the `/runs/<id>` page component to remove Tool payload truncation and add a `Raw` tab that renders the full ordered transcript and exposes JSON export.

### Question 4 — Async /workers/drafts sequencing

- **Pick:** (b) Backend agent fixes the 500 first; async migration is a separate Codex job after
- **Why:** A known 500 on `/workers/drafts` is a correctness bug; async migration is a product/runtime change. Fixing the failure path first reduces ambiguity, gives you a working baseline, and prevents mixing reliability repair with a queueing/async architecture decision in one rushed pass.
- **Next step:** Fix the failing `/workers/drafts` handler in the FastAPI backend first, then open a separate job for async draft execution.

---

## Codex verification note (verbatim)

> No file reads, code inspection, or runtime verification were performed because you explicitly requested decision-only architecture guidance from the prompt alone. These are opinionated calls based strictly on the provided context.

## Token usage

`25,514` tokens used on the second (medium-reasoning) run.

## Raw output

Preserved at `/tmp/codex-consult-output-v2.txt`.
