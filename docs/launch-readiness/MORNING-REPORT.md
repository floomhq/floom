# Morning Report — 2026-05-26

**Generated:** Automated final audit, ~09:45 CEST
**Full audit:** `docs/launch-readiness/agent-runs/final-audit-2026-05-26.md`

---

## TL;DR

The API is solid: auth, security headers, rate limiting, secret isolation, E2E runs for all 3 worker types (agent/pure-script/DACH), and E2B isolation for the pure-script path all pass clean. Agent runs use AgentDriver in the API process and were tested as trusted platform-controlled execution, not as sandbox-isolated bundles. The P1 blocker (`draft-from-prompt` 67% failure rate from unquoted-colon YAML) is **fixed and live** as of PR #33: stricter system prompt + `response_format=json_object` + 3-attempt retry loop. Smoke-tested 5/5 against the live API at 09:33 UTC — all parse cleanly, zero retries needed. The UI walks (prompt-to-worker flow, inline secrets #31, cancel button #32) still need the operator's eyes in browser, Vercel deploy protection blocks automated verification from AX41.

**Top 3 things to check first when you wake up:**
1. **`draft-from-prompt` in browser** — go to workers.floom.dev/workers/new, type a prompt, verify it returns a draft worker without error. The retry fix is live; a red toast should now be rare. If you do see one, journal logs at `journalctl -u workeros-api.service -g "YAML validation failed"` will show which attempt failed.
2. **Inline secrets + OAuth flow on `/workers/new` Step 2** — verify the Connection picker shows app slugs as "Connection" (not "Composio"), and the secret input works.
3. **Cancel button on a running job** — start a `research_brief` run from the UI, click cancel, confirm the run reaches `failed` status with "Run cancelled by user" message.

**Biggest open question:** None blocking. Remaining gaps are UI verification walks behind the Vercel auth wall.

---

## What Landed Overnight (PRs #29–#33)

| PR | Description |
|----|-------------|
| [#29](https://github.com/floomhq/workeros/pull/29) | Cut approvals and pause/unpause endpoints, `/runs/{id}/approve`, `/workers/{id}/pause`, `/approvals` all return 404. Verified live. |
| [#30](https://github.com/floomhq/workeros/pull/30) | Prompt-to-worker on `/workers/new`, `POST /workers/draft-from-prompt` endpoint ships; UI wires the new worker creation step. |
| [#31](https://github.com/floomhq/workeros/pull/31) | Inline secrets + OAuth on `/workers/new` Step 2, white-labeled "Connection" replaces "Composio" in all user-facing strings; 0 occurrences of "Composio" remain in `apps/web/src`. |
| [#32](https://github.com/floomhq/workeros/pull/32) | Migrated 5 stock workers to E2B-native `run.py` contract, all 5 (`csv_enricher`, `resume_helper`, `dach_compliance`, `crm_matcher`, `gmail_intake_brief`) now read `inputs.json` + write `result.json`. 22 em-dashes replaced throughout. |
| [#33](https://github.com/floomhq/workeros/pull/33) | Fix `draft-from-prompt` YAML reliability, stricter system prompt requiring double-quoted strings + `response_format=json_object` + 3-attempt retry loop on `parse_worker_manifest` failure. Live smoke 5/5, 0 retries. |

---

## What Was Verified Live

### API + Endpoints
- `/healthz` and `/health` return `{"status":"ok"}` 200 when called with secret (app exemption works; Cloudflare WAF blocks AX41 IPv6 for unauthenticated calls — not a functional issue)
- `/workers` without secret: 403
- `/workers` with secret: 7 workers listed
- `research_brief`: `exec.mode=agent`, `runtime.type=skill`
- `csv_enricher`: `exec.mode=pure-script`, `runtime.type=python311`
- `draft-from-prompt`: returns valid draft (connected=`github`+`notion`, suggested_name, required_secrets, valid YAML) when gpt-4o-mini cooperates
- All cut endpoints return 404: approve, pause, /approvals

### E2E Worker Runs
- **research_brief** (agent/skill/AgentDriver in API process): completed in ~16s, 2 artifacts, 5 transcript entries, `brief` markdown output present
- **csv_enricher** (pure-script/python311/E2B): completed in <8s, `enriched_csv` output with new column
- **dach_compliance** (pure-script/python311/E2B): completed, 3 output fields (`compliance_report`, `rate_benchmark`, `red_flags` with risk_level=LOW)
- **Cancel in-flight**: `POST /runs/{id}/cancel` → `status=cancel_requested` (200) → run transitions to `status=failed`, `error="Run cancelled by user"`

### Security
- Path traversal on `/uploads` (`../../etc/passwd`): blocked with 400
- Rate limit: 220 burst → 144 OK + 76 × 429 with `Retry-After: 60`
- Security headers: HSTS, X-Frame-Options, CSP, Permissions-Policy, X-Content-Type-Options, Referrer-Policy all present
- No env secrets leaked in `/workers`, `/runs`, `/secrets`, `/connections` bodies
- `/secrets` returns `status=set` with no raw value
- E2B sandbox isolation: malicious `os.environ` dump inside E2B returned only sandbox metadata — FLOOM_SECRET, OPENAI_API_KEY, COMPOSIO_API_KEY, COMPOSIO_WEBHOOK_SIGNING_KEY, E2B_API_KEY all absent from sandbox

### Code
- 0 em-dashes in `apps/web/src`
- 0 user-facing "Composio" strings in `apps/web/src`
- 0 sensitive `NEXT_PUBLIC_*_KEY/SECRET/TOKEN` vars
- All 5 pure-script workers follow E2B-native `inputs.json` / `result.json` contract

---

## What Was NOT Verified (the operator Must Check in Browser)

Vercel deploy protection on workers.floom.dev blocks unauthenticated requests from AX41. All UI verification requires the operator's authenticated session:

1. **workers.floom.dev general navigation** — does the app load, routes work, no JS errors
2. **Prompt-to-worker UI (#30)** — `/workers/new`, type a prompt, verify draft populates (also surfaces the draft-from-prompt reliability P1 if it's still broken in the UI)
3. **Inline secrets + OAuth (#31)** — Step 2 connection picker shows "Connection" label, secret input works
4. **Cancel run button (#32)** — `/runs/[id]` cancel UI triggers `POST /runs/{id}/cancel`, run transitions to failed state
5. **Worker catalog display** — 7 workers render correctly in the library view

To disable deploy protection for a one-time audit pass: Vercel dashboard → workeros project → Settings → Deployment Protection → temporarily disable or add bypass token.

---

## Known Issues / Things That May Still Need Attention

| Priority | Issue | Status |
|----------|-------|--------|
| P1 | `draft-from-prompt` returns 502 ~67% of calls (LLM YAML validation failure) | **Fixed in PR #33** — stricter prompt + `response_format=json_object` + 3-attempt retry. Live smoke 5/5. |
| Low | `/healthz` blocked from AX41 IPv6 by Cloudflare WAF when no secret sent | Open, add AX41 IPv6 to CF WAF allowlist for `/healthz` path |
| Spec note | `error_code` field absent from cancel response (spec says `error_code=cancelled`, API says `error="Run cancelled by user"`) | Won't fix unless spec is the external API contract |
| Pending | UI walk (5 items above) | the operator to verify in browser |

---

**SCORE: 92/100** (was 88/100, P1 fix lifts the draft-from-prompt reliability check)
