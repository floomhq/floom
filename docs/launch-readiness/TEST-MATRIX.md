# Launch Readiness Test Matrix

Single source of truth for what gets audited every time. If a row is not checked, the launch readiness report explicitly says "NOT CHECKED" with a reason.

## Surfaces

| # | Surface | What it is | Tested by | Current state |
|---|---|---|---|---|
| 1 | API | 30 REST routes on `workers-api.floom.dev` | `codex-roast` lifecycle + `codex-security` OWASP | ✅ done (79+68 pre-fix → re-running) |
| 2 | MCP | HTTP `/mcp-tools/serve` plus `workeros-mcp` stdio fallback, 50+ tools | `apps/mcp npm test` + prod MCP smoke | ✅ tested 2026-06-08 |
| 3 | CLI | `floom <subcommand>` Python Click CLI | `cli-smoke` (NEW) | ❌ not yet |
| 4 | UI | 12 frontend routes on `workers.floom.dev` | `ui-walk` via authenticated chrome | ❌ blocked by Vercel deploy protection |
| 5 | Triggers — manual | POST /workers/{id}/runs | `codex-roast` | ✅ done |
| 6 | Triggers — cron | scheduled fire via croniter | `cron-firing` (NEW) | ❌ not yet (time-based) |
| 7 | Triggers — webhook | HMAC POST /webhooks/{id} | `codex-security` (signature) + `webhook-firing` (full path) | 🟡 partial |
| 8 | Triggers — Composio | event from real SaaS into /composio-events | requires you connecting Gmail | ❌ deferred (no triggers registered yet) |
| 9 | Sandbox — E2B pure-script | `.py`/`.sh`/`.js` workers in E2B microVMs | `e2b-run` (NEW) | ❌ not yet (e2b_test worker exists but not exercised) |
| 10 | Agent runtime — in-process | `SKILL.md` / `.md` workers through API-host AgentDriver | manual end-to-end + security review for tool scopes | ✅ done (this turn) |
| 11 | Execution policy | Product decision: agent workers are trusted platform code, not sandbox-isolated user scripts | docs/security review | ✅ documented 2026-06-09 |
| 12 | File uploads | /uploads sha256 dedup + per-run mount | `codex-roast` step 8 | ✅ done |
| 13 | Auth — secret gate | x-floom-secret at WAF + origin | `codex-security` | ✅ done (post-fix) |
| 14 | Auth — HMAC webhook | per-worker secret rotation | `codex-security` | ✅ done |
| 15 | Auth — Composio sig | signing key verification | `codex-security` (post-fix) | ✅ done |
| 16 | Cost caps | max_tool_iterations, max_output_tokens | `agent-cost-cap` (NEW) | ❌ not yet |
| 17 | Persistence | DB rows, artifacts, logs survive restart | `restart-survival` (NEW) | ❌ not yet |
| 18 | Disaster — process crash mid-run | run leaves clean state | `crash-recovery` (NEW) | ❌ not yet |

## Method

For each surface in the matrix:

1. **Test plan** lives at `docs/launch-readiness/test-plans/<surface>.md`
2. **Agent dispatch** runs against the LIVE system (not stubs)
3. **Evidence** saved at `docs/launch-readiness/agent-runs/<agent>-evidence/`
4. **Verdict file** at `docs/launch-readiness/agent-runs/<agent>-<date>.md`
5. **Score** 0-100 ending with `SCORE: NN/100`
6. **Aggregator** composites scores weighted by surface importance

## Composite score weights

| Surface bucket | Weight |
|---|---|
| API (auth + lifecycle + error paths) | 30% |
| MCP (agent's primary interface) | 20% |
| UI (frontend) | 15% |
| Agent runtime (the actual product execution) | 15% |
| Triggers (cron/webhook/composio) | 10% |
| CLI | 5% |
| Sandbox / execution policy (E2B pure-script + trusted in-process agents) | 3% |
| Disaster recovery | 2% |

Sum = 100. If a surface is `N/A` for this project, redistribute its weight proportionally across the rest.

## Status (this turn)

- API: re-running post-fix (codex-security-rerun + codex-roast-rerun in flight)
- MCP: dispatching new `mcp-integration` agent
- CLI: dispatching new `cli-smoke` agent
- UI: dispatching new `ui-walk` via authenticated chrome broker
- E2B pure-script: dispatching new `e2b-run` agent
- Agent in-process boundary: documented in `ARCHITECTURE.md` and `docs/SECURITY-DATA-MAP.md`
- Cron / webhook firing / cost caps / restart survival: queued
