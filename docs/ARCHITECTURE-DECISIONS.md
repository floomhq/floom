# Floom Architecture Decisions (ADR log)

Single source of truth for locked product + architecture decisions. ADR-style: each entry has the decision, the WHY, and the date locked. New decisions append at the bottom; never edit history (correct via a follow-up entry that supersedes).

When a decision is in flight or contested, it goes to **Open Questions** at the bottom. Once locked, it moves to a numbered ADR.

Locked: 2026-04-26 (architecture sprint, Federico + Claude + codex consult)

---

## ADR-001 — Creator analytics

**Date locked:** 2026-04-26
**Decision:** Creators see aggregate run counts only by default. Identified per-run runner identity is opt-in only with explicit per-run user consent. Inputs and outputs of a run are PRIVATE to the runner — never visible to the creator without a per-run "share with creator for improvement" toggle (v1.1).

**Why:** This is a competitive moat. SaaS norm is to show creators everything; that erodes user trust. Floom's promise is "your data is yours" — that's the differentiator from Replit/Glitch/StackBlitz on consumer-facing AI apps.

**Supersedes:** None.

---

## ADR-002 — Source visibility is a separate dimension from app visibility

**Date locked:** 2026-04-26
**Decision:** `apps.source_visible: bool` is a per-app creator-controlled flag, separate from the app-visibility tier (Private / Link / Invited / Public). Source visible → app is forkable. Source hidden → app cannot be forked.

**Why:** Visibility (who can RUN the app) and source visibility (who can SEE the code + fork) are different product axes. Some creators want source open for trust + community, others want closed for IP protection.

**Open question:** When a creator flips `source_visible` from true → false, what happens to existing forks? **Locked: existing forks keep working as independent copies.** Standard fork semantics (GitHub model).

---

## ADR-003 — Workspaces and roles

**Date locked:** 2026-04-26
**Decision:**
- v1: single-user workspaces only.
- v1.1: multi-user team workspaces.
- Role names: keep DB's existing `admin / editor / viewer` (per `apps/server/src/db.ts:654`). Earlier mention of `admin/contributor/runner` was a casual rename — codex audit caught the mismatch.

**Why:** Backend audit (PR #788) revealed workspace tables, membership, roles, and invites already exist in the DB schema. v1.1 work is exposing the existing primitive in UI, not building from scratch.

---

## ADR-004 — Runtime box

**Date locked:** 2026-04-26
**Decision:**
- Sync run timeout: 5 min (matches `apps/server/src/services/docker.ts:17` default 300s).
- Async job timeout: 30 min (matches `apps/server/src/services/jobs.ts:10` default).
- Per-app CPU + memory limits enforced at container spawn (already shipped via Docker isolation).
- Async queue: deferred to v1.1.

**Why:** Sync vs async are intentionally different paths. Document the split. v1.1 adds proper job queue (BullMQ or SQLite-backed) for heavier workloads.

---

## ADR-005 — App versioning

**Date locked:** 2026-04-26
**Decision:**
- v1: latest-only. New push from creator updates the live app for everyone.
- v1.1: full versioning + draft/staging/promote-to-prod flow with CI/CD gates ("CI/CD out of the box" for creators).

**Why:** v1 launch scope. Versioning + rollback is non-trivial. v1.1 delivers the "protect users from shit work" promise via mandatory tests before promote-to-prod.

---

## ADR-006 — Free at launch

**Date locked:** 2026-04-26
**Decision:** All apps are free to run at v1 launch. No payment, no metering visible to user. v1.1+ ships token/Stripe-based monetization (revenue split, refund policy, tax handling tracked separately).

**Why:** Viral coefficient at launch matters more than revenue. Stripe webhook handling primitives already exist in code; we wire them in v1.1.

---

## ADR-007 — Database

**Date locked:** 2026-04-26
**Decision:**
- v1: SQLite (with WAL mode enabled, already configured per backend audit). Single-host writes only.
- v1.1+: migrate to Postgres when a clear scale signal is reached. Migration trigger: 10k DAU OR write QPS ≥ 100/sec OR cross-host horizontal scaling required.
- Daily encrypted snapshots to Backblaze B2 already shipped (PR #785).
- Backup scope at Monday launch: DB only (per #785). v1.1 expands to Docker volumes (`DATA_DIR`, `apps/`, `renderers/`, `.floom-master-key`) per `docs/extended-audit/ax-11-data-lifecycle.md:127`. Documented as INCOMPLETE for Monday.

**Why:** SQLite + WAL is robust to ~1k writes/sec on a single host. Premature Postgres migration is overkill. Monday launch backup scope is honest acknowledgment that full disaster recovery comes in v1.1.

---

## ADR-008 — App sharing model (4 tiers, 6 states, moderated public)

**Date locked:** 2026-04-26
**Decision:** Apps have 6 visibility states. Default for newly published app: **Private**.

| State | Who can run it | Listed on store? |
|---|---|---|
| Private | Owner only | No |
| Link-only | Anyone with secret URL `/p/:slug?key=<token>` | No |
| Invited | Specific Floom usernames or email-invited recipients | No |
| Pending review | Owner submitted; awaiting Floom team approval. Behaves like Private to non-owner. | No |
| Public-Live | Approved by Floom team. Anyone can run + see in `/apps`. | Yes |
| Changes requested | Reviewer rejected with notes. Behaves like Private. Owner fixes + resubmits → back to Pending review. | No |

State transitions enforced server-side. Audit log every transition.

**Why:** Defaults must be private (privacy moat from ADR-001). Public listing requires Floom-team review (curated store, trust, anti-spam). Link-share keeps the low-friction "send a friend a runnable AI app" pattern.

**Per-app config flag:** `link_share_requires_auth: bool` (default false). When false, anyone with the link can run anonymously (rate-limited). When true, only signed-in users can run via the link. Notion model.

**Migration of existing `apps.auth_required` field:** This field today maps to a shared `FLOOM_AUTH_TOKEN` bearer (per `apps/server/src/lib/auth.ts:151`), NOT membership-based. Map to `link_share_requires_auth=true` rather than the new `Invited` tier — semantics differ. Earlier draft mapping ("auth-required → invited") was wrong; codex caught the conflict.

---

## ADR-009 — Agents-native (4 surfaces, agent tokens unify auth)

**Date locked:** 2026-04-26
**Decision:**
- 4 surfaces: Web UI, MCP server, REST API, CLI.
- v1 ships: Web UI, MCP, REST. CLI is v1.1 (power users use REST in the meantime).
- Agent tokens are the single auth primitive across MCP + REST + CLI. Same token works in all three surfaces.
- Token format: `floom_agent_<32-char-base62>`. Hashed (SHA-256) at rest. Prefix shown for ID. Shipped in PR #786.
- Multiple tokens per user (GitHub PAT model). Each labeled, scoped, and rate-limited.
- Single-workspace binding (one token = one workspace). Multi-workspace federation is v1.1+.

**Scope model (revised after codex consult):** strict no-overlap. Better naming than original `read/read-write/publish-only`:
- `apps:read` — list/discover apps
- `run` — execute apps (read + run)
- `secrets:update` — update per-app secrets the token's user owns
- `publish` — create + update apps the token's user owns

Tokens carry one or more scopes. UI surfaces "preset bundles" (Read-only / Read+Run / Read+Run+Publish / Full) for usability.

**Phase rollout:**
- 2A-backend (PR #786) — token primitive, mint/list/revoke endpoints, bearer auth, per-token rate limit. SHIPPED.
- 2B (in flight) — MCP read/run tools.
- 2C — REST API parity for read tools.
- 2D — write tools (create_app, publish, secrets) gated behind moderation.
- 2E — CLI npm package.
- 2F — Clawdbot wiring + agent docs rollout.

**Why:** Tokens unify because the auth primitive is identical. Different surfaces (HTTP vs WebSocket vs CLI subprocess) just consume the same token.

---

## ADR-010 — Email

**Date locked:** 2026-04-26
**Decision:** Resend (already wired in `apps/server/src/lib/email.ts`). Provision `RESEND_API_KEY` env var on prod + preview hosts.

**Production deploy gate:** server startup must FAIL HARD if `RESEND_API_KEY` is unset in prod. Today's behavior (graceful degrade to stdout including auth emails per codex finding) is acceptable for dev but unacceptable for prod — silent loss of password-reset and verification emails.

**SPF/DKIM/DMARC for floom.dev:** Resend DKIM already installed at `resend._domainkey.floom.dev`. SPF includes `_spf.perfora.net + _spf.kundenserver.de + amazonses.com`. DMARC TBD — track separately.

---

## ADR-011 — Run retention

**Date locked:** 2026-04-26
**Decision:** Run data is retained INDEFINITELY by default. No automatic sweeper.

- Users can delete their own runs at any time via `/me/runs/:id`.
- Workspace owners can bulk-delete their workspace runs.
- Creators can declare `max_run_retention_days` per app (e.g. compliance-sensitive apps default to 90d). When set, runs older than the floor are automatically deleted.
- Account deletion (ADR-012) sweeps the user's runs as part of the cleanup.

**Why:** ChatGPT/Claude/Notion all keep user data indefinitely. Privacy moat is "no one else sees your data" (ADR-001), not "we delete your data". Different axis. Default-delete-fast surprises users who want to come back to their old runs.

**Supersedes:** earlier draft "30d sweeper" — Federico pushed back: "users also want their run data maybe."

---

## ADR-012 — Account deletion

**Date locked:** 2026-04-26
**Decision:** Soft-delete with 30-day undo window. Permanent delete after grace period.

State machine:
- User clicks "Delete my account" → state `pending_delete`, `delete_at = now() + 30d`.
- During grace: account locked (can't sign in), all sessions revoked, no data deleted yet.
- User can "Undo delete" within 30 days → state `active`, full restoration.
- After 30 days: cascade delete user-owned data (runs, secrets, agent tokens, invites). Public apps owned by the user are orphaned to a `local` system user (ADR-008) unless creator explicitly opted to delete them too.
- Audit log retains an anonymized actor ID forever (no email, no name).

**Implementation gap:** Current `apps/server/src/lib/better-auth.ts:479` and `cleanup.ts:19` perform HARD-DELETE today. Soft-delete + tombstone is a v1.1 backend task. Until shipped, the UI uses hard-delete + a clear "this is permanent" warning.

**Why:** GDPR-friendly. Lets users undo regret-deletes. Anonymized audit log preserves accountability without retaining PII.

---

## ADR-013 — Audit log

**Date locked:** 2026-04-26
**Decision:**
- Audit log table records every visibility transition, admin action, account deletion, agent-token mint/revoke, secret update, fork creation.
- Retention: 1 year baseline. Admin actions retained forever (compliance).
- Format: `{ id, actor_user_id_anonymized?, actor_token_id?, action, target_type, target_id, before_state, after_state, metadata, created_at }`.

**Implementation gap:** Codex audit found the admin route has NO audit log today (`apps/server/src/routes/admin.ts:1`). Build the table + write rows from every state-change endpoint as part of the sharing-logic backend task already in flight.

**Why:** Compliance, debugging, abuse forensics. 1-year baseline is industry norm.

---

## ADR-014 — DDoS / abuse posture

**Date locked:** 2026-04-26
**Decision:**
- v1 launch: rate limits per IP / per user / per agent-token (already shipped, PR #783 + #786). Process-local counters; reset on restart.
- IP block list (manual at first; admin UI in v1.1+).
- v1.1: Cloudflare WAF in front of AX41 if traffic warrants.

**Limitation acknowledged:** Rate limits are process-local. No global per-slug spend cap. Botnets across many IPs CAN burn one popular app's free runs. This is acceptable for launch (3 showcase apps, bounded inputs); not acceptable at scale → spend cap track in v1.1.

**Why:** Don't over-engineer for launch traffic. Cloudflare WAF is ~$200/mo + integration cost. Defer until traffic data demands it.

---

## ADR-015 — GitHub deploy path

**Date locked:** 2026-04-26
**Decision:**
- v1 launch: public repos only. Creator pastes a public GitHub URL on `/studio/build`; Floom clones, builds, publishes.
- Personal Access Token (PAT) paste fallback for users who want private-repo support without installing the Floom GitHub App.
- v1 week 1 (post-launch): Floom GitHub App (selective-repo install, fine-grained access, revocable). Standard Vercel/Netlify pattern.
- Webhook on `push` → auto-rebuild (already infra-ready per `apps/server/src/services/triggers-worker.ts`).

**Why:** Public repos cover the launch demo + showcase apps. Private-repo + GitHub App is a 1-2 day ship after launch. PAT fallback covers the gap.

---

## ADR-016 — Trust & safety / malicious app policy

**Date locked:** 2026-04-26
**Decision:**
- Outbound network from app containers is BLOCKED BY DEFAULT.
- Creators declare allowed outbound domains in `floom.yaml` (`allowed_domains: [api.openai.com, ...]`). Validated at publish time.
- Floom-team review (ADR-008) checks allowlist for suspicious domains before approving for the public store.
- v1.1+ workstream: formal Acceptable Use Policy + content moderation pipeline + automated abuse signals + reporter UI for flagging apps + takedown SLA + appeals process.

**Why:** Default-deny network prevents the worst exfiltration class (creator publishing an app that silently sends user input to their own webhook). Explicit allowlist forces creators to declare their integration intent. Container-level isolation already exists (Docker dropped caps, read-only fs); this adds network policy.

**v1.1 follow-up:** "we need clear policies and app content reviews in the future" — locked as a separate v1.1 workstream. Specifics TBD.

---

## Open Questions (not yet locked)

These are surfaced from codex consult / backend audit / Federico-flagged. Each tracks an ADR-pending decision.

### OQ-001 — Workspace analytics access (v1.1)
When teams ship in v1.1, who in a workspace sees app run analytics? All members? Editors+? Admins only?

### OQ-002 — Fork inherits creator secrets at fork-time?
When user forks a public app, do they inherit the creator's secret references (e.g., the creator's Gemini key budget) or must they detach + provide their own?
- Default leaning: fork detaches secrets. User must add their own keys.
- Tension: zero-friction fork wants inheritance. Cost accountability wants detachment.

### OQ-003 — Agent token binding scope
Current ADR-009: tokens bind to one workspace. Open: should tokens optionally bind tighter (workspace + specific app, or workspace + scope subset)?
- v1: workspace-level only. Refine in v1.1 after usage data.

### OQ-004 — Revoked workspace member token validity
When workspace removes a member, do their previously minted agent tokens still work?
- Default leaning: tokens auto-revoked on workspace eviction.

### OQ-005 — Self-host identity federation
Self-host README says "self-host today, cloud goes live 27 April." Open: do self-host instances federate identity to floom.dev cloud (single sign-on, shared tokens), or are they fully isolated forever?
- v1: self-host is locally scoped. No cloud federation.
- v2 (much later): consider federated identity if multi-cloud usage emerges.

### OQ-006 — API compatibility promise
What's the deprecation policy for `/api/:slug/run`, MCP tool schemas, manifest version? Semver-style? Best-effort? Floor-N-versions?
- Default leaning: manifest schema is versioned (`manifest_version: "2.0"` already in code). REST + MCP tools are best-effort with 90d deprecation notices.

### OQ-007 — BYOK cost tracking + surface
When user provides their own Gemini key (BYOK), Floom should not bill them for Floom's key usage. Currently BYOK is special-cased for 3 demos. Open:
- Track per-token Gemini spend on Floom's key + surface in `/me` so user knows when to add their own?
- Today: only the 5-free-runs gate enforces it.
- v1.1: explicit cost surface.

### OQ-008 — Outage UX (web up, runner host down)
What does the user see if AX41 runner is down but `floom.dev` web is up? Today: probably 500 with no useful info. Need a friendly "Floom is recovering, your runs will retry" pattern + email notification on long outages.

### OQ-009 — Public content + abuse policy specifics
ADR-016 sets the technical default-deny network. Open: what's the human-readable Acceptable Use Policy? Banned content categories? Reporting mechanism? Appeals process?

### OQ-010 — DMARC policy for floom.dev
SPF + DKIM are configured per ADR-010. DMARC TBD. Choices: `p=none` (monitor only), `p=quarantine`, `p=reject`. Default leaning: `p=quarantine` after 30d of `p=none` monitoring.

---

## Codex consult corrections (2026-04-26)

The decisions above incorporate corrections from a codex consult (gpt-5.5) that reviewed the original Federico locks + Claude picks against actual codebase. Key corrections:

1. **Account deletion (ADR-012)** — original "soft-delete 30d" assumed soft-delete already implemented. Code is hard-delete. ADR-012 documents the implementation gap.
2. **`auth_required` migration (ADR-008)** — original "map to invited" was wrong. Code's `auth_required` = shared bearer token, not membership. Map to `link_share_requires_auth=true` instead. Preserves semantics.
3. **Agent token scopes (ADR-009)** — original `read/read-write/publish-only` naming was misleading. Better: `apps:read / run / secrets:update / publish` with bundled presets. Codex's call.
4. **Audit log retention (ADR-013)** — original 1y assumed audit log exists. Code has none. ADR-013 documents the build-then-retain order.
5. **Resend production gate (ADR-010)** — codex flagged real bug: Resend env-missing falls back to stdout INCLUDING auth emails. Production deploy must crash on missing env.
6. **Workspace role names (ADR-003)** — DB has `admin/editor/viewer`. Earlier draft mentioned `admin/contributor/runner`. Keep the DB names; that was a casual rename, not a redesign.
7. **Backup scope (ADR-007)** — original DB-only Monday is acceptable IF documented as incomplete. ADR-007 documents the scope.

---

## ADR-017 — Shadcn UI adoption (post-launch v1.1, prep tooling now)

**Date locked:** 2026-04-26
**Decision:**
- ADOPT Shadcn for commodity UI primitives: Dialog, Tabs, Dropdown, Command palette (cmdk), Toast (sonner), Popover, Sheet (vaul), Select, Switch / Checkbox / Radio.
- KEEP custom for Floom-voice surfaces: HeroDemo (3-state morphing canvas), output renderer cascade (#768), hero metric tile (`/me`, `/studio`, `/studio/:slug`), app cards (showcase + dashboard), sharing visibility ladder (4-tier + 6 states), agent-tokens display, studio rail (sidebar with workspace switcher).
- TIMING: post-launch (v1.1), NOT in the launch sprint. v1 ships on current custom code.

**Why post-launch (Option A from codex consult):**
- Migration surface is bigger than headline: 11 dialog-like surfaces (not 3), 8 tablist surfaces, **2,519 inline-style hits** across `apps/web/src/`.
- `apps/web/src/styles/wireframe.css` is load-bearing global CSS that owns "every component" — fights Shadcn's token shape if not migrated together.
- Tuesday 2026-04-28 launch is in <2 days. Migration risk beats engineering neatness.
- Bundle delta estimate (codex): +25-45 KB gzip if careful, +50-75 KB if shared barrel.
- Saaspo bar (Federico's anchor) is visual polish + curation, not just primitives.

**Hard rule: theme aggressively or it'll scream "AI-template SaaS".** Override every Shadcn default with Floom's `wireframe.css` tokens (`--bg`, `--card`, `--ink`, `--muted`, `--line`, `--accent`, Inter heavy 800 with tight tracking, hairline shadow `0 1px 0 rgba(17,24,39,0.02)`, radius scale 16/20px). Strip all `shadow-sm` + slate/zinc defaults.

**Tooling shipped tonight (prep for v1.1):**
- Shadcn MCP server connected to Claude Code: `shadcn: npx shadcn@latest mcp`
- `/shadcn` skill at `~/.claude/skills/shadcn/SKILL.md` — Floom-themed scaffolding workflow + Shadcn-vs-custom decision rules
- `/saaspo` skill at `~/.claude/skills/saaspo/SKILL.md` — design reference workflow (saaspo.com curated SaaS gallery)
- Codex prompt template at `docs/ops/codex-shadcn-prompts.md` (codex doesn't have skill-loading; documented prompts achieve the same)
- Mirror skills to Clawdbot at `/opt/clawdbot/data/skills/{shadcn,saaspo}/`

**v1.1 migration sequence:**
- Day 1: init shadcn + 4 modal retrofits (BYOK, Waitlist, Share, Skill-install)
- Day 2-3: Command palette (cmdk) + Toast (sonner)
- Day 4-5: Tabs migration across `/p/:slug` + `/me` + `/studio/:slug` (parallel)
- Week 2: Sheet (vaul) for mobile drawer, then Dropdown / Popover / Select rollout
- Long-tail: 2,519 inline-style hits → Tailwind utility migration via codex codemod

**Saaspo bar test:** before merging a Shadcn-themed component, ask "would Linear / Vercel / Resend / Supabase ship this exact component?" If yes → ship. If looks like a Vercel template, theme isn't aggressive enough.

---

## ADR-018 — Mobile coverage: inline per page, not separate files

**Date locked:** 2026-04-26
**Decision:** Every wireframe shows BOTH desktop AND mobile (375px) viewports in the same file, side-by-side or stacked. NO separate `*-mobile.html` files.

**Why:** v18 v4 had only 3 mobile files (landing-mobile, me-mobile, studio-home-mobile) out of 80 wireframes. Federico's read: "mobile is not just one out of six stickers... for each desktop version there also has to be a mobile version." Mobile is a state of every page, not an optional companion file. Forcing it inline guarantees coverage at the wireframe stage instead of as an afterthought.

**Implementation pattern:** v19 wireframes use a 2-column layout in the wireframe scaffold — desktop (1280-1440px viewport mock) on the left, mobile (375px viewport mock) on the right. Same page, same content, two breakpoints. Tablet (768px) optional but recommended for pages with significant mid-breakpoint behavior.

**Anti-pattern banned:** wrapping mobile views inside fake iPhone illustrations (rounded corners, device chrome). Mobile shows the actual 375px viewport rendering, no illustration scaffolding.

---

## ADR-019 — Wireframe versioning: freeze old, fresh number for next

**Date locked:** 2026-04-26
**Decision:** When a wireframe iteration hits "good enough as a reference for code" or when significant rework would create legacy/iteration confusion, archive the current version directory READ-ONLY and start the next iteration in a fresh-numbered directory.

- v17 → archived at `/var/www/wireframes-floom/v17/`, frozen
- v18 (v1, v2, v3, v4 sub-iterations all done) → archive at `/var/www/wireframes-floom/v18/`, frozen
- v19 → fresh start at `/var/www/wireframes-floom/v19/` for the next round

**Why:** Federico's read: "we should not have legacy + v4, it's confusing. Let's just make the next v v19 to avoid these confusions." Sub-iteration naming (v1, v2, v3, v4) was useful in-flight but creates ambiguity once shipped. Fresh major numbers eliminate that.

**Process:**
- Archive previous version as read-only on the static host. Old links keep working forever.
- Each major version has its own design-system, IA, changelog, audit, index.
- The CHANGELOG carries forward critical decisions but doesn't try to be a unified history — that's what this ADR doc is for.
- Sub-iteration files (`vN-AUDIT.md`, `vN-CHANGELOG.md`) live INSIDE the major-version directory, not at the root.

**No more naming like "v18 v4" or "legacy". Either it's the active version or it's archived.**

---

## ADR-020 — Comprehensive backend testing is a hard merge gate

**Date locked:** 2026-04-26
**Decision:** Every backend PR (any change to `apps/server/src/`) MUST include comprehensive tests covering happy paths + unhappy paths + edge cases. Codex review verifies. PR is FAIL-gated until tests are comprehensive.

**Why:** Federico's bar: "EVERYTHING tested. Cases. Happy and unhappy paths. Edge cases." Silent breakage is the worst kind of regression.

### What "comprehensive" means

For every endpoint or public function added/modified:

**Happy paths** (3+ tests typical): standard success for every input variant; multi-step flows; idempotent re-runs return same result.

**Unhappy paths** (10+ tests typical):
- Auth missing → 401 / wrong/expired/revoked → 401 / wrong scope → 403
- Resource not found → 404
- Each required input missing or wrong type → 400 with clear validation
- Body too large → 413
- Rate limit exceeded → 429 with Retry-After
- Method not allowed → 405
- Conflict (duplicate slug, illegal state transition) → 409

**Edge cases** (5+ tests typical):
- Empty / single-char / unicode-emoji / very-long (10K+) / SQL-injection-style / path-traversal inputs
- Null/undefined where required
- Concurrent requests (race conditions)
- Time/numeric boundaries

**Concurrency / state** (3+ tests for stateful endpoints):
- Two concurrent writes — both succeed without collision OR enforced state machine wins
- Cleanup sweepers running while user is active — no data corruption
- Token boundary conditions (just-expired, just-issued, near-revoke)

**Hard rule:** No PR merges until codex review confirms tests cover all four categories for every changed surface.

**Implementation track:** Comprehensive test coverage audit + gap fills shipped via PR `codex/comprehensive-test-coverage` (audit doc + new test files). After that PR lands, every future backend PR follows this policy.

---

## ADR-021 — Full launch readiness checklist

**Date locked:** 2026-04-26
**Decision:** Backend is "launch-ready" when ALL six gates below pass. Every gate is checkable; no subjective sign-off.

### Gate 1 — All architectural decisions implemented (not just locked)

| ADR | Implementation status required |
|---|---|
| ADR-008 sharing | 4-tier visibility + state machine + invites + review queue (PR #790, in flight) |
| ADR-009 agents-native | Phase 2A token primitive (#786, merged) + Phase 2B MCP read/run (#789, in flight) |
| ADR-010 email | Resend wired + production hard-fail on missing key (in flight) |
| ADR-011 retention | Per-app `max_run_retention_days` + user delete + sweeper (in flight) |
| ADR-012 account deletion | Soft-delete tombstone + 30d undo + cascade (queued post-#790) |
| ADR-013 audit log | Audit table + writes from every state-change endpoint (queued post-#790) |
| ADR-014 DDoS | Rate limits per IP + user + token (#783 + #786 merged) |
| ADR-015 GitHub deploy | Public-repos paste-URL flow + webhook (in flight) |
| ADR-016 trust+safety | Outbound network deny default + floom.yaml allowlist (in flight) |

### Gate 2 — Comprehensive testing (per ADR-020)

- Every changed backend file has happy + unhappy + edge tests
- Total test count ≥ 500 across `test/stress/*.mjs`
- Full regression run: green
- No flaky tests (deterministic over 5 consecutive full runs)

### Gate 3 — Operational readiness

- Backups working: PR #785 merged + DSN env vars set + verified end-to-end (test backup + test restore once)
- Observability: PR #787 merged + Sentry DSN env vars in prod + first error captured in Sentry dashboard
- Discord webhook alerts firing on real errors (already shipped)
- `/api/health` returns 200 + meaningful liveness signal
- Post-deploy smoke gate (PR #782) firing on every deploy

### Gate 4 — Documentation complete

- `docs/ARCHITECTURE-DECISIONS.md` (this file, current)
- `docs/testing/coverage-policy.md` (ADR-020 spec)
- `docs/security/network-policy.md` (ADR-016)
- `docs/ops/db-backup.md` (PR #785)
- `docs/ops/sentry.md` (PR #787)
- `docs/agents/quickstart.md` + `docs/agents/mcp-tools.md`
- `docs/sharing.md` + `docs/admin/review-queue.md`

### Gate 5 — Security

- All launch-week security issues closed (#767, #765, #380, #691, #779, #781, #783, #786 — done)
- No new security issues opened during the launch sprint
- Trust+safety policy live (ADR-016)
- Account deletion flow verified end-to-end (ADR-012)

### Gate 6 — Performance baseline

- Cold-start on prod: < 3s
- Sync run latency: < 5min hard timeout (ADR-004)
- DB query timing: no N+1 on hot paths (verify via slow-query log)

**When all 6 gates pass, backend is launch-ready. Until then, NOT launch-ready, no excuses.**

---

## ADR-022 — No UI code changes until v19 is locked + Federico-approved

**Date locked:** 2026-04-26
**Decision:** Zero changes to `apps/web/` source code until v19 wireframes are:
1. Drafted by the v19 agent
2. Codex-consult-reviewed (adversarial pass)
3. Federico-spot-checked + signed off
4. Locked as the final design source of truth

**Why:** Federico's exact words: "v19 to be perfect before we do UI changes." UI code based on half-baked spec creates rework loops. Lock the design first, build once.

**Concretely until v19 lock:**
- v19 wireframes in flight (Claude sonnet agent at `/var/www/wireframes-floom/v19/`)
- After agent returns: codex consult adversarial review against ADRs + saaspo bar + anti-patterns
- Codex flags → v19 v2 patches
- Federico spot-checks 5 priority pages in browser
- When Federico says "ship this design", UI code unfreezes
- Shadcn migration (ADR-017) happens AFTER UI unfreeze, in v1.1 sequence

**Hard rule:** No exceptions. Bugfixes to UI wait until v19 lock UNLESS they're scoped to non-visual changes (a11y fix that doesn't touch layout, console-warning silencing, dependency upgrade with no visual impact).

**Single exception class:** Critical security fixes that happen to live in UI code (e.g., XSS in a render path) — fix immediately, design can catch up.

---

## How to add a new ADR

1. Append to bottom (don't insert mid-doc).
2. ADR number is sequential; never reuse.
3. Required fields: Date locked, Decision, Why.
4. If the decision supersedes an earlier one, cite it explicitly.
5. Open questions go to "Open Questions" section until locked. When locked, promote to numbered ADR.
