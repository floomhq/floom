# Assessment iteration loops — full spec (the operator 2026-05-28)

Cross-agent rule (the operator mandate): no agent audits what it built.

## UI loop — runs after every UI PR merges

```
trigger: PR merged + workers.floom.dev re-aliased
artifacts dir: docs/audits/overnight-2026-05-28/ui-cycle-N/
```

1. **ux-review-everywhere** skill (Claude, programmatic walk)
   - Routes auto-detected from `apps/web/app/`
   - Screenshots: 375 / 768 / 1280 / 1600 × signed-in / signed-out / empty
   - Checks: heading dup, overlay occlusion, toast positioning, content overflow,
     console errors, network 4xx/5xx, touch targets <44px, contrast <4.5:1
   - Output: per-route P0/P1/P2 with evidence PNGs

2. **layout-eyes** skill (Claude, adversarial visual)
   - Catches what programmatic checks miss: footer floating above viewport bottom,
     sidebar bg ending before main content, filter rows wrapping to row 2,
     nowrap+ellipsis on mobile, descender clipping on flex-shrunk text
   - Output: P0/P1 with annotated screenshots

3. **claude-virgin** Agent (fresh-context general-purpose, NO implementation memory)
   - "Walk every page like a first-time user. Click everything that looks
     clickable. Roast UX dimensions: visual hierarchy, typography, spacing,
     contrast, mobile, empty states, microcopy, affordances, delight."
   - 60 min budget, releases broker lease

4. **/design-review** skill (Gemini-3.1 vision judge — IF the operator re-authorises Gemini)
   - Sends screenshots to Gemini, scores 7 design dimensions per page
   - Score: 0-100 with per-dimension breakdown
   - GATED on the operator's earlier ban of paid Gemini calls — defer unless he explicitly lifts.

5. **Aggregate** → `docs/audits/overnight-2026-05-28/ui-cycle-N/findings.md`
   - Findings get new I-N IDs, merged into `ISSUES.md`
   - Cross-agent agreement check: if two agents flag the same issue, P0/P1 upgrade
   - Disagreements logged, NOT averaged

6. **Fix loop**: every P0 from this cycle goes into the NEXT UI batch immediately.
   Cycle ends when 2 consecutive cycles add zero P0/P1.

## Backend loop — runs after every backend PR merges

```
trigger: PR merged + systemctl restart workeros-api
artifacts dir: docs/audits/overnight-2026-05-28/be-cycle-N/
```

1. **/codex review** skill (codex, adversarial code review)
   - Reads the diff that just merged
   - Focuses on: silent-empty fallbacks, swallowed Promise errors, vendor-contract
     assumptions, missing error envelopes, wrong status codes
   - Output: P0/P1 with line refs

2. **/cso** skill (security audit, OWASP + STRIDE)
   - Re-run Round 5's 28 probe matrix: SQLi, command injection, path traversal,
     XXE, GraphQL, method override, response splitting, cache poisoning, host
     header bypass, TRACE, subdomain enum, ReDoS, prototype pollution, ZIP
     traversal, exposed config, directory listing, plus the 2 fresh ones
     (CORS, /uploads)
   - Output: verified safe + new findings

3. **kimi-agent** (Kimi CLI, hard-mode probe — the operator's request)
   - Stateless: hit every endpoint with adversarial inputs
   - Sql-injection shapes, oversized payloads, race conditions, auth bypass
   - Output: P0/P1 with reproducer commands

4. **Worker smoke (lane D)** — actually invoke every stock worker
   - research_brief, weekly_update, csv_enricher, dach_compliance,
     reverse_match_crm, cv_writeup, gmail_intake_brief, e2b_test, schedule_test,
     webhook_test, webhook_secret_test, input_types_test
   - Real inputs (use `worker.example_input`)
   - Wait for completion, log status/duration/output
   - Any `status=failed` → P0 with run_id evidence

5. **/pragmatic-pr-reviewer** skill — launch-risk surface
   - New env vars → .env.example up to date?
   - New deps → package.json / requirements.txt?
   - New endpoints → OpenAPI?
   - Breaking changes → all callers updated?

6. **Aggregate** → `docs/audits/overnight-2026-05-28/be-cycle-N/findings.md`

## Cross-cutting agents — run at most once per night

- **claude-virgin** real-user 22-step walk: signup-style flow (create worker
  → run it → see error → edit → re-run → green). the operator's "full flow" gate.
- **/launch-readiness** skill: composite 0-100 score with 12 categories,
  weighted total, P0/P1 ranked. Final-gate sign-off.

## Stop conditions

The overnight session ends when ANY of:
1. **Score ≥ 95** + zero open P0/P1 + every stock worker green = SHIP
2. **5 consecutive batches with no new findings** = ship at current score
3. **Codex token budget exhausted** (separate from the operator's account)
4. **the operator wakes up** and gives new direction
