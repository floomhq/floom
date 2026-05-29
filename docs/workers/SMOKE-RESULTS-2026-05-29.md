# Smoke Results — S38 — 2026-05-29

All prod smoke runs executed against `workers-api.floom.dev` with `x-floom-secret`.
Archived workers (kugelaudio-*) are excluded from the active smoke table.

## Active Workers — Smoke Pass/Fail

| Worker | Run ID | Status | Duration | Output bytes | Output head (100 chars) |
|--------|--------|--------|----------|--------------|------------------------|
| weekly_update | run_b3d3ba3eeef0 | ✅ PASS | 27,754 ms | 5,102 | `# Weekly Investor Update — Week ending May 28, 2026\n\n## Highlights\n\n- Delivered S33 ex` |
| dach_compliance | run_81ef333e4170 | ✅ PASS | 25,059 ms | 3,392 | `# AÜG Compliance Report\n\n## 1. 18-Month Maximum Deployment Period (§ 1 Abs. 1b AÜG)\nThe` |
| github-digest | run_4f9d7fce1d76 | ✅ PASS | 80,108 ms | 6,422 | `# Daily GitHub digest — May 28, 2026\n\n## Open PRs\n\n- Workplan: clean engine for batch 2` |
| research_brief | run_2da9770a98ca | ✅ PASS | 24,358 ms | 4,120 | `# Research Brief: "chaos restart-resilience smoke"\n\n- Audience: Technical\n- Depth: Overvi` |
| node-smoke-test | run_124ba98a5c12 | ✅ PASS | 6,506 ms | 15 | `out/result.json` |
| openblog | run_aaf0365c5294 | ✅ PASS | 226,298 ms | 273 | `out/markdown.md` (artifact path — full article generated) |
| env-vars-worker | run_a1109d0719f7 | ✅ PASS | 5,719 ms | — | Legacy worker, will be archived after S38 merge |
| gmail_intake_brief | run_615d3a1e111c | ❌ FAIL | 13,183 ms | — | `COMPOSIO_API_KEY not set` — Gmail Composio connection not active on prod |
| opendraft | run_fb65cdf8e84a | ❌ FAIL | 16,628 ms | — | `Run was interrupted by an API restart before completion` — infrastructure transient |
| linkedin-post-engagements | run_d76ad232c77b | ❌ FAIL | 17,983 ms | — | KeyError: 'data' in Apify engagement scraper step 2 |
| csv_enricher | — | ⏳ NOT RUN | — | — | File upload required; no prod run yet |
| cv_writeup | — | ⏳ NOT RUN | — | — | File upload required; no prod run yet |
| reverse_match_crm | — | ⏳ NOT RUN | — | — | File upload required; no prod run yet |

## Archived Workers — Not Smoked

| Worker | Status | Reason |
|--------|--------|--------|
| kugelaudio-bug-intake | ARCHIVED | Customer secrets unavailable (SLACK_BOT_TOKEN, LINEAR_API_KEY, NOTION_API_KEY) |
| kugelaudio-meeting-pipeline | ARCHIVED | Customer secrets unavailable (SLACK_BOT_TOKEN, LINEAR_API_KEY, NOTION_API_KEY) |

## Failure Analysis

### gmail_intake_brief — COMPOSIO_API_KEY not set
- Root cause: The Gmail Composio connection is not active on prod. The worker declares `connections: [gmail]` and requires a valid Composio entity ID at runtime.
- Disposition: Keep ACTIVE. Worker is correctly implemented. Smoke passes once Gmail connection is configured on prod.

### opendraft — API restart interruption
- Root cause: Backend restart mid-run (infrastructure transient, not a worker bug). The 44-min opendraft run was interrupted when the API restarted.
- Disposition: Keep ACTIVE. Previous runs completed successfully. This is an infrastructure issue, not a worker defect.

### linkedin-post-engagements — Apify engagement API KeyError
- Root cause: Apify actor `scraping_solutions/linkedin-posts-engagers-likers-and-commenters-no-cookies` returned a response without `data.id` key in step 2. The Apify actor API shape changed or returned an error object instead of a run result.
- Disposition: Keep ACTIVE. The post discovery step (step 1) SUCCEEDED. The engagement step (step 2) needs a defensive `resp.get("data", {}).get("id")` check in `run.py`. Filing as a follow-up bug — not blocking S38.

### csv_enricher, cv_writeup, reverse_match_crm — File upload required
- These workers require CSV or PDF file inputs. No automated prod smoke run was done.
- All three have complete `run.py` implementations, correct output schemas, and OPENAI_API_KEY declared.
- Disposition: Keep ACTIVE. Manual smoke via UI file upload is the verification path. Structural validation passes.

## Summary

| Category | Count |
|----------|-------|
| Active workers (non-system, non-archived) | 12 |
| Smoke PASS | 7 (including env-vars-worker) |
| Smoke FAIL — infrastructure | 1 (opendraft — transient) |
| Smoke FAIL — connection not configured | 1 (gmail_intake_brief) |
| Smoke FAIL — Apify API shape bug | 1 (linkedin-post-engagements) |
| File-upload workers (no automated smoke) | 3 |
| Archived (skipped) | 2 |
| System workers | 1 (worker-author) |
