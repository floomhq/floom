# Security + Product Audit — 2026-06-01

Scope:
- `floomhq/workeros` at `86b3ea3` plus the fixes in this working tree.
- Live checks against `workers.floom.dev`, `workers-api.floom.dev`, `workeros.floom.dev`, and `workeros-api.floom.dev` from AX41.
- Independent Codex read-only audit session `019e819d-407b-7c63-8769-50e187dfbfff`.

## Verified Fixed In This Round

| ID | Item | Verification |
|---|---|---|
| S-1 | Local agent-mode Composio execution now uses the run owner and resolved owner connection instead of the first active app connection. | `python3 -m pytest tests/test_agent_driver.py tests/test_composio_execute_owner_scope.py apps/api/tests/test_composio_proxy.py apps/api/tests/test_run_token.py -q` -> 36 passed. |
| S-2 | Local agent `invoke_worker` now requires an authenticated owner and verifies the target worker belongs to that owner before creating/executing a child run. | Same 36-test suite; new `test_invoke_worker_requires_authenticated_owner`. |
| S-3 | Sandbox run tokens are now valid only for `/runs/{run_id}/composio-execute/{tool}` and must match the path run id. | Same 36-test suite; `apps/api/tests/test_run_token.py` updated to reject `/workers` with run tokens. |
| S-4 | E2B workers already receive `WORKEROS_RUN_TOKEN`; the proxy now requires it. | `apps/api/runner_sandbox/e2b_driver.py` injects `WORKEROS_RUN_TOKEN`; proxy tests pass with signed headers. |

## Verified Still Open

| Priority | Item | Evidence / status |
|---|---|---|
| P0 | OSS Next proxy is too broad for a public deployment. | `apps/web/app/api/proxy/[...path]/route.ts` injects `FLOOM_API_SECRET` and exports `GET/POST/PUT/PATCH/DELETE` without a user/session boundary. This remains open because the OSS app currently has no login layer; fixing it needs a product decision on public read-only vs authenticated dogfood. |
| P1 | Legacy `connections: [gmail]` declarations still grant full app tool access. | `declared_composio_connections()` treats legacy strings as unrestricted. Structured `allowed_tools` is enforced. Migration to explicit allowlists remains open. |
| P1 | Standalone/shareable approval page is not shipped. | Existing `/approvals` is in-app. No single-approval external page for worker-spawned approvals was found. |
| P1 | Slack is not proven end-to-end. | UI has Agent Channels status, but no verified Slack app event loop/mention-to-agent E2E receipt in this audit. |
| P1 | Overview still needs first-viewport fit and data consistency review. | Federico screenshot shows vertical scroll and `queued`/`coming up today` mismatch. Needs browser verification after UI pass. |
| P1 | Workspace switcher has UI/state bugs. | Federico reported hover black state and newly-created workspace not selectable. Needs route/state reproduction. |
| P1 | Worker cards and detail pages have inconsistent app/connection icons. | Federico provided card/detail screenshots; card top strip must show the same detail-page icons and remove extra top whitespace. |
| P1 | Brain UI is incomplete. | Brain icon missing in left nav/detail tab in places; worker detail needs connected brain packs as a first-class section, not worker requirements copy. |
| P1 | Source file previews are incomplete. | All source files need raw and rendered modes; HTML/CSV/XLSX/PDF/video previews remain open. |
| P1 | Agent page IA needs cleanup. | Instructions vs resolved prompt is unclear, settings belong lower/secondary, channel connection state needs real linkage. |
| P1 | Connections UI needs account identity and loading/error states. | Supabase connection screen showed a spinner/active row with weak account label; app + account must be shown together. |
| P1 | CLI/MCP setup snippets still need product polish. | Needs workspace token context, Codex target, and chips matching the design system. |
| P1 | Workspace fork/share/transfer is not proven. | Fork/duplicate/share-by-link and transfer including secrets need explicit product + security design. |

## Stale Or Corrected Claims From Previous Report

| Claim | Current status |
|---|---|
| Web frontend has 43 Turbopack module errors. | Stale. `npm run build` passed locally before this patch on AX41. Independent Codex build failed only in a read-only/offline temp copy because Google Fonts fetch was blocked. |
| Vitest missing. | Stale. `apps/web npm test` passed: 1 file, 9 tests. |
| `search_console_insights` is DELETE-unprotected. | Stale from code audit: worker declares read/query GSC tools only; no DELETE tool found. |
| Cloud API CORS broken. | Stale for Cloud: `https://workeros-api.floom.dev/api/workers` OPTIONS returned 200 with `Access-Control-Allow-Origin: https://workeros.floom.dev`. |
| `workers-api.floom.dev` unauthenticated health/preflight blocked by Cloudflare. | Still observed from AX41. This is an edge/WAF behavior, not FastAPI code behavior; it blocks anonymous probes before the API. |

## Security Checklist Coverage

| Check | Status |
|---|---|
| Privacy policy if user data is collected | Present: `apps/web/app/privacy/page.tsx`. |
| Know where user data is stored | Present: `docs/SECURITY-DATA-MAP.md`. |
| Security headers | Present on web config and verified live earlier: CSP, HSTS, frame deny, nosniff, referrer, permissions policy. |
| OWASP basics | Partial pass; open P0 proxy auth boundary and P1 legacy connection scope. |
| SQL injection / XSS / auth issues | SQL mostly repository/parameterized; auth issues above. |
| `.env` values leaking | No frontend `NEXT_PUBLIC_*` secret leak found in this audit; platform keys stay server-side. |
| API responses sensitive data | Secret values are not returned by design; detailed `/health` still discloses key names/config state and remains low-priority open. |
| Secrets in logs | Redaction path documented in `SECURITY-DATA-MAP.md`; no new raw-secret log sink found in the inspected paths. |
| API keys in frontend code | No API keys found in frontend source; the P0 is server-side proxy capability exposure, not literal key exposure. |
| Move keys server-side/proxy | Already server-side; proxy needs auth/allowlist boundary. |
| Rate limits | Present in API middleware; in-memory and local-dev bypass remain documented limitations. |

## Verification Commands

```bash
python3 -m py_compile apps/api/main.py apps/api/runner_sandbox/agent_driver.py
python3 -m pytest tests/test_agent_driver.py tests/test_composio_execute_owner_scope.py apps/api/tests/test_composio_proxy.py apps/api/tests/test_run_token.py -q
```

Result: `36 passed in 9.94s`.
