# Product Feedback Reconciliation - 2026-06-01

## Scope

This is lane A: product-feedback reconciliation. It does not edit application code.

## 2026-06-01 18:20 CEST Operational Update

This update supersedes older rows in this document that said the OSS Workers API was still Cloudflare-blocked or that versioning routes were returning 404.

Verified fixed:

- `workers-api.floom.dev` health is reachable: public `GET /healthz` returns `200 {"status":"ok"}`.
- Browser CORS preflight is reachable: `OPTIONS /workers` with `Origin: https://workers.floom.dev` and `Access-Control-Request-Method: GET` returns `200` with CORS headers.
- OSS versioning routes are live behind Cloudflare with the production `x-floom-secret`: `/workspace/versions`, `/workers/weekly_update/versions`, and `/contexts/rocketlist-seo-reports/versions` each return `200 []`.
- The OSS API service now runs GitHub source from `/opt/workeros-api-main` at `floomhq/floom@04e1591`, replacing the stale detached `/opt/workeros-live` source that caused Vivek's 404s.
- The Cloud API service now runs `/opt/workeros-cloud` at `floomhq/workeros-cloud@985eea6` with engine submodule `04e1591`.
- Cloud versioning route aliases exist at both root and `/api`; unauthenticated requests now return `401`, not `404`.
- Both backend API services have systemd auto-deploy timers from GitHub `main`. The units live at `/etc/systemd/system/workeros-api-autodeploy.*` and `/etc/systemd/system/workeros-cloud-api-autodeploy.*`; scripts live at `/usr/local/bin/workeros-api-autodeploy` and `/usr/local/bin/workeros-cloud-api-autodeploy`. The timers fired at 18:19 CEST and both one-shot services exited `0/SUCCESS`.

Still open after this operational pass:

- Slack is not end-to-end verified.
- Command-first MCP add/import is not implemented.
- Standalone approval-review pages are not implemented.
- Workspace fork/share/transfer is not implemented.
- Telemetry/data collection is documented but not implemented.
- Email notifications are not verified production-ready.
- UI polish items for overview/cards/Brain/source/connections remain.
- Granular connection-scope UI remains incomplete.
- Workspace switcher and per-workspace token behavior need live authenticated retest.

Products:

| Surface | Repo | Live app | API | Current local evidence |
| --- | --- | --- | --- | --- |
| Workeros OSS app | `/tmp/workeros-ui-round2` / `floomhq/floom` | `https://workers.floom.dev` | `https://workers-api.floom.dev` | local HEAD `7d820b1` |
| Workeros Cloud wrapper | `/root/workeros-cloud` / `floomhq/workeros-cloud` | `https://workeros.floom.dev/app` | `https://workeros-api.floom.dev` | local HEAD `d635005`, `engine` submodule `7d820b1` |

Product boundary: Workeros is the information worker OS app. Workeros Cloud is only the hosted wrapper around that app, adding OAuth, Supabase, workspaces, and Cloud routing. The Cloud repo must stay in sync with Workeros without overwriting Cloud-specific overlay features.

Sources used:

- Current Codex conversation and Federico screenshots in this lane.
- Claude session audit docs under `/root/.claude/projects`, especially the mined audit summarized in `/root/workeros-cloud/engine/docs/audits/feedback-completeness-audit-2026-05-29.md`.
- `/tmp/workeros-ui-round2/docs/FEEDBACK-LEDGER.md`.
- `/tmp/workeros-ui-round2/docs/audits/security-product-audit-2026-06-01.md`.
- `/root/workeros-cloud/docs/STATUS-SLACK-WORKSPACE-AGENT-DX-2026-06-01.md`.
- `/root/workeros-cloud/docs/API-BACKEND-BRIEFING-VIVEK.md`.
- `/root/workeros-cloud/docs/WORKSPACE-TOKENS-2026-06-01.md`.
- Current code inspection in both repos.
- Live endpoint checks from AX41.

Status precedence:

1. Later Federico re-raises beat older merged/fixed claims.
2. Live evidence beats local-only claims.
3. `2026-06-01` docs beat `2026-05-29` docs.
4. A feature with backend support but missing or confusing UI is listed as partial.

## Live Checks Performed

| Check | Result |
| --- | --- |
| `https://workers.floom.dev/brain` | `200` |
| `https://workers.floom.dev/assistant` | `200` |
| `https://workeros.floom.dev/app/overview` without session | `307` to `/login?next=%2Fapp%2Foverview`; cloud sign-out/auth guard is now active |
| `https://workeros-api.floom.dev/healthz` | `{"status":"ok","deploy":"cloud"}` |
| `https://workers-api.floom.dev/healthz` from AX41 | `200 {"status":"ok"}` after Cloudflare rule fix |
| `OPTIONS https://workers-api.floom.dev/workers` from AX41 | Browser preflight returns `200` with CORS headers after Cloudflare rule fix |

## Implemented Or Mostly Implemented

| ID | User-raised item | Current status | Evidence |
| --- | --- | --- | --- |
| I-01 | Keep Workeros and Workeros Cloud distinct, with Cloud as a wrapper only. | Implemented as repo instruction and briefing. | `/root/workeros-cloud/CLAUDE.md:3-23`, `/root/workeros-cloud/CLAUDE.md:46-71`, `/root/workeros-cloud/docs/API-BACKEND-BRIEFING-VIVEK.md:5-14`. |
| I-02 | Keep Cloud synced with Workeros without losing Cloud-only workspace/auth features. | Implemented structurally; still requires ongoing sync discipline. | `/root/workeros-cloud/docs/API-BACKEND-BRIEFING-VIVEK.md:154-185`; `engine` submodule currently pins Workeros `7d820b1`. |
| I-03 | Use separate API backends for OSS and Cloud. | Implemented and documented. | `/root/workeros-cloud/docs/API-BACKEND-BRIEFING-VIVEK.md:7-14`, `/root/workeros-cloud/docs/API-BACKEND-BRIEFING-VIVEK.md:16-44`. |
| I-04 | Cloud sign-out must not continue showing the app UI. | Implemented in Cloud middleware and verified live. | `/root/workeros-cloud/web/overlay/middleware.ts:15-59`; live `/app/overview` redirects unauthenticated users to login. |
| I-05 | Cloud needs email auth in addition to Google. | Implemented in Cloud auth routes. | `/root/workeros-cloud/apps/api/routes/auth.py:654-670` for logout; code-evidence lane also found email/password auth route coverage in `apps/api/routes/auth.py`. |
| I-06 | Workspace-scoped API tokens; switching workspaces must not show the same token as universal credential. | Implemented in branch, with migration requirement. | `/root/workeros-cloud/docs/WORKSPACE-TOKENS-2026-06-01.md:3-13`; verification `11 passed` at lines `14-21`; migration prerequisite at lines `23-24`. |
| I-07 | Settings moved out of main nav / lower in sidebar. | Implemented in OSS sidebar. | `/tmp/workeros-ui-round2/apps/web/components/layout/sidebar.tsx` inspected; settings rendered in bottom section. |
| I-08 | Agent/workspace-agent has a left-nav tab with subtabs. | Implemented shell, still product-copy partial. | `/tmp/workeros-ui-round2/apps/web/app/assistant/page.tsx:20-22`, `/tmp/workeros-ui-round2/apps/web/app/assistant/page.tsx:268-276`; `https://workers.floom.dev/assistant`. |
| I-09 | Worker detail needs a Brain tab and Brain icon. | Implemented in worker-detail nav. | `/tmp/workeros-ui-round2/apps/web/app/workers/[id]/page.tsx:80-145`. |
| I-10 | Worker detail needs attach/remove of brain packs. | Implemented mechanically, UX still partial. | `/tmp/workeros-ui-round2/apps/web/app/workers/[id]/page.tsx:2423-2577`. |
| I-11 | Worker versions. | Implemented backend and worker-detail UI. | `/tmp/workeros-ui-round2/apps/api/main.py:1974-2025`, `/tmp/workeros-ui-round2/apps/web/app/workers/[id]/page.tsx:2806-2865`. |
| I-12 | Agent instruction versions. | Implemented backend and assistant UI. | `/tmp/workeros-ui-round2/apps/api/main.py:12008-12060`, `/tmp/workeros-ui-round2/apps/web/app/assistant/page.tsx:55-90`, `/tmp/workeros-ui-round2/apps/web/app/assistant/page.tsx:268-276`. |
| I-13 | Database-backed versioning exists for mutable assets. | Implemented at repository/API layer for workers, brain packs, and workspace instructions. | `/root/workeros-cloud/supabase/migrations/0013_asset_versions.sql:1-30`; `/root/workeros-cloud/apps/api/db/supabase_repos.py:2118-2201`; `/tmp/workeros-ui-round2/apps/api/main.py:1864-1898`, `1974-2025`, `2113-2160`, `12008-12060`. |
| I-14 | In-app approvals page exists. | Implemented in-app only; standalone page remains open. | `/tmp/workeros-ui-round2/apps/web/app/approvals/page.tsx` inspected; security audit still lists standalone as open at `/tmp/workeros-ui-round2/docs/audits/security-product-audit-2026-06-01.md:23`. |
| I-15 | Connection tool scoping for prompt-injection risk. | Implemented for structured `allowed_tools`, partial for legacy string declarations. | `/tmp/workeros-ui-round2/docs/audits/security-product-audit-2026-06-01.md:22`; `/root/workeros-cloud/docs/STATUS-SLACK-WORKSPACE-AGENT-DX-2026-06-01.md:25`. |
| I-16 | Security fixes for Composio owner scoping, worker invocation scoping, run tokens. | Implemented in current security audit. | `/tmp/workeros-ui-round2/docs/audits/security-product-audit-2026-06-01.md:8-15`; auth/run-token code at `/tmp/workeros-ui-round2/apps/api/main.py:804-872`. |
| I-17 | Telemetry requirement captured. | Documented, not implemented as data collection. | `/root/workeros-cloud/docs/TELEMETRY-DATA-COLLECTION-2026-06-01.md`. |
| I-18 | `workers.floom.dev/workers` empty-list incident diagnosed and fixed. | Implemented per briefing; needs live regression monitoring. | `/root/workeros-cloud/docs/API-BACKEND-BRIEFING-VIVEK.md:115-152`. |

## Partially Implemented

| ID | User-raised item | Current status | Evidence |
| --- | --- | --- | --- |
| P-01 | Brain tab/icon is missing in places; Brain must feel first-class. | Mostly implemented in nav and worker detail, but UX still reads as "resources/requirements" and latest screenshots show confusion. | `/tmp/workeros-ui-round2/apps/web/app/workers/[id]/page.tsx:140`, `2423-2577`; user screenshot `lane-b-workers-weekly-update-brain-tab-2048.png`. |
| P-02 | Brain packs attached to worker must be visible and editable clearly. | Attach/remove exists, but copy and hierarchy are confusing. | `/tmp/workeros-ui-round2/apps/web/app/workers/[id]/page.tsx:2454-2457`, `2534-2567`. |
| P-03 | Brain page three-column alignment. | Brain page exists; latest screenshot still shows header/border alignment complaint. | `/tmp/workeros-ui-round2/apps/web/app/contexts/page.tsx` inspected; screenshot path `docs/launch-readiness/agent-runs/screenshots/lane-b-workers-brain-2048.png`. |
| P-04 | Source tab needs raw and rendered for all files. | Raw/rendered tabs exist for text source, but rendered mode only special-cases YAML and Markdown. | `/tmp/workeros-ui-round2/apps/web/components/worker-form/FilesEditor.tsx:214-238`, `320-370`. |
| P-05 | YAML rendered view is questionable and "Brain packs shown with worker requirements" is confusing. | YAML renderer explicitly includes Brain resources in requirements-style summary. | `/tmp/workeros-ui-round2/apps/web/components/worker-form/FilesEditor.tsx:378-408`. |
| P-06 | HTML/CSV/XLSX/PDF/video previews. | Brain/file preview code recognizes types, but screenshots show XLSX/PDF/video/HTML preview failures or incomplete behavior. | Screenshot paths: `lane-b-workers-brain-xlsx-error-2048.png`, `lane-b-workers-brain-pdf-direct-2048.png`, `lane-b-workers-brain-video-direct-2048.png`, `lane-b-workers-brain-html-direct-2048.png`. |
| P-07 | Worker card top bar has extra whitespace and card icons differ from detail page icons. | Some icon consistency work landed, but latest user screenshots still re-raised the card whitespace/icon mismatch. | `/tmp/workeros-ui-round2/docs/FEEDBACK-LEDGER.md:226-227`; `/tmp/workeros-ui-round2/docs/audits/security-product-audit-2026-06-01.md:27`. |
| P-08 | Overview must fit the first viewport and counts must be coherent. | Prior compression exists, but latest screenshot shows cut-off cards and count mismatch. | `/tmp/workeros-ui-round2/docs/FEEDBACK-LEDGER.md:233`; `/tmp/workeros-ui-round2/docs/audits/security-product-audit-2026-06-01.md:25`. |
| P-09 | Agent page: Instructions vs Final/Resolved prompt is hard to understand. | Tabs exist with explanatory copy, but latest feedback says the distinction remains unclear. | `/tmp/workeros-ui-round2/apps/web/app/assistant/page.tsx:268-324`; `/tmp/workeros-ui-round2/docs/FEEDBACK-LEDGER.md:231`. |
| P-10 | Agent instructions must not be editable by default; edit mode needed. | Current UI renders editable textarea immediately. | `/tmp/workeros-ui-round2/apps/web/app/assistant/page.tsx:279-305`. |
| P-11 | Agent/worker model declaration visible. | No model field verified on assistant info route/UI. | `/root/workeros-cloud/docs/STATUS-SLACK-WORKSPACE-AGENT-DX-2026-06-01.md:21`; `/tmp/workeros-ui-round2/docs/FEEDBACK-LEDGER.md:237`. |
| P-12 | Slack integration. | Generic Composio Slack surface exists; no Slack-native event/channel/binding E2E proof. | `/root/workeros-cloud/docs/STATUS-SLACK-WORKSPACE-AGENT-DX-2026-06-01.md:11-28`, `39-47`; `/tmp/workeros-ui-round2/docs/FEEDBACK-LEDGER.md:232`. |
| P-13 | Connections rows need app plus account name, scopes, and useful loading/error states. | API/UI have some account/status support, but latest user screenshot shows cryptic fragments/spinner/fake-feeling status. | `/root/workeros-cloud/docs/STATUS-SLACK-WORKSPACE-AGENT-DX-2026-06-01.md:25`; `/tmp/workeros-ui-round2/docs/FEEDBACK-LEDGER.md:228-229`. |
| P-14 | Supabase connection flow looked fake/confusing. | Composio redirect flow exists; status display and post-auth card remain confusing per latest screenshot. | `/tmp/workeros-ui-round2/docs/FEEDBACK-LEDGER.md:229`; latest screenshot in user message. |
| P-15 | MCP server addition must feel command-first, not a generic form. | MCP page supports HTTP/SSE form and JSON import; stdio-only requires an HTTP endpoint first. | `/tmp/workeros-ui-round2/apps/web/app/connections/mcp/page.tsx:245-350`. |
| P-16 | Import existing MCPs from Claude/Cursor configs. | Partial: HTTP/SSE JSON import exists; stdio import remains open. | `/tmp/workeros-ui-round2/apps/web/app/connections/mcp/page.tsx:340-345`; `/root/workeros-cloud/engine/docs/audits/feedback-completeness-audit-2026-05-29.md:46-47`. |
| P-17 | CLI/MCP setup needs easier auth, token inclusion, Codex target, chips matching design. | Partial: Cloud token copy and CLI paths improved; broader setup UI polish remains. | `/tmp/workeros-ui-round2/docs/FEEDBACK-LEDGER.md:230`; `/root/workeros-cloud/docs/STATUS-SLACK-WORKSPACE-AGENT-DX-2026-06-01.md:22-24`. |
| P-18 | Workspace switcher on OSS and Cloud, with workspace selection working reliably. | Infrastructure exists; latest feedback reports hover black state and new workspace not selectable. | `/tmp/workeros-ui-round2/docs/FEEDBACK-LEDGER.md:234`; Cloud workspace routing evidence `/root/workeros-cloud/apps/api/auth/supabase_provider.py:270-321`, `/root/workeros-cloud/web/overlay/lib/server-api.ts:20-40`. |
| P-19 | Workspace-scoped tokens per workspace. | Implemented in branch, but deployment/migration is a prerequisite. | `/root/workeros-cloud/docs/WORKSPACE-TOKENS-2026-06-01.md:8-24`. |
| P-20 | Versioning for all assets including workers, Brain, agent instructions. | Backend exists; UI exists for worker and assistant instructions; Brain UI missing versions. | `/tmp/workeros-ui-round2/apps/api/main.py:1864-1866`, `2113-2160`; worker UI `/tmp/workeros-ui-round2/apps/web/app/workers/[id]/page.tsx:2806-2865`; assistant UI `/tmp/workeros-ui-round2/apps/web/app/assistant/page.tsx:55-90`. |
| P-21 | Documentation/templates must be clear for virgin agents creating/running/editing workers. | Docs and CLI commands exist, but virgin-agent deployment UX was scored 65/100 in the user-provided test transcript. | `/root/workeros-cloud/docs/STATUS-SLACK-WORKSPACE-AGENT-DX-2026-06-01.md:22-24`; user transcript notes missing smooth `workeros push`/validation/deploy clarity. |
| P-22 | Naming pass: apps -> connections, contexts -> brain. | Partial: main nav and aliases use Brain/Connections, but older labels/legacy hashes remain. | `/tmp/workeros-ui-round2/apps/web/app/workers/[id]/page.tsx:102-120`; `/tmp/workeros-ui-round2/docs/FEEDBACK-LEDGER.md:238`. |
| P-23 | Email notifications/welcome emails. | Unclear-to-partial: older audit mentions SMTP alerting, but Cloud welcome/product email system was not proven in this lane. | `/root/workeros-cloud/engine/docs/audits/feedback-completeness-audit-2026-05-29.md:161`; current Cloud email notification system not verified. |
| P-24 | Launch security checklist. | Partially complete: several fixes landed; public OSS proxy, legacy connection scope, WAF, and product gaps remain. | `/tmp/workeros-ui-round2/docs/audits/security-product-audit-2026-06-01.md:17-59`. |
| P-25 | Collect product telemetry/data with disclosure, export, delete, and redaction. | Documented only. | `/root/workeros-cloud/docs/TELEMETRY-DATA-COLLECTION-2026-06-01.md`. |
| P-26 | GSC/Search Console worker must declare connections and brain. | User-provided transcript says worker was fixed; platform protection/runtime state remains open in security/readiness docs. | Security/readiness item for protected workers in user-provided Round 2 report; current protected set lacks `search_console_insights` at `/tmp/workeros-ui-round2/apps/api/main.py:246-268`. |
| P-27 | Overview/cards dark-mode colors and chips must match design system. | Some design tokens exist; latest screenshots still show mismatch/cutoff. | `/tmp/workeros-ui-round2/docs/FEEDBACK-LEDGER.md:226-233`; latest user screenshots. |

## Not Implemented Or Still Open

| ID | User-raised item | Current status | Evidence |
| --- | --- | --- | --- |
| O-01 | Standalone approval page for one or several approvals without entering the app. | Not implemented. | `/tmp/workeros-ui-round2/docs/audits/security-product-audit-2026-06-01.md:23`; `/tmp/workeros-ui-round2/docs/FEEDBACK-LEDGER.md:236`. |
| O-02 | Workspace fork/duplicate UI. | Not implemented/proven. | `/tmp/workeros-ui-round2/docs/FEEDBACK-LEDGER.md:235`; security audit line `/tmp/workeros-ui-round2/docs/audits/security-product-audit-2026-06-01.md:33`. |
| O-03 | Workspace share-by-link / worker sharing by link. | Not implemented/proven. | Same evidence as O-02. |
| O-04 | Workspace transfer including secrets, with security design. | Not implemented/proven. | Same evidence as O-02. |
| O-05 | Slack-native Events API, slash commands, interactivity, channel binding, and listener/posting loop. | Not implemented. | `/root/workeros-cloud/docs/STATUS-SLACK-WORKSPACE-AGENT-DX-2026-06-01.md:13-19`, `52-58`. |
| O-06 | Brain pack versions visible in Brain UI. | Not implemented in UI. | Backend exists at `/tmp/workeros-ui-round2/apps/api/main.py:2113-2160`; no Brain Versions UI found in inspected Brain page. |
| O-07 | Full generalized asset version UI for all asset classes. | Not implemented. | Version APIs exist, but UI coverage is worker + assistant only. |
| O-08 | Agent instructions edit-lock mode. | Not implemented. | Current textarea is editable immediately at `/tmp/workeros-ui-round2/apps/web/app/assistant/page.tsx:299-304`. |
| O-09 | First-class per-worker permission review page for granular connection scopes/tools. | Not implemented/proven. | `/root/workeros-cloud/docs/STATUS-SLACK-WORKSPACE-AGENT-DX-2026-06-01.md:25`; security audit legacy-scope issue `/tmp/workeros-ui-round2/docs/audits/security-product-audit-2026-06-01.md:22`. |
| O-10 | True OAuth-scope least privilege per agent when user connected a broad Gmail account. | Not implemented as a UI/product flow. Tool allowlists exist; separate OAuth configs not proven. | User-provided Composio note; security audit line `/tmp/workeros-ui-round2/docs/audits/security-product-audit-2026-06-01.md:22`. |
| O-11 | Stdio MCP server support in E2B/sandbox. | Not implemented. | `/root/workeros-cloud/engine/docs/audits/feedback-completeness-audit-2026-05-29.md:46-47`; MCP import copy says stdio needs HTTP endpoint at `/tmp/workeros-ui-round2/apps/web/app/connections/mcp/page.tsx:340-345`. |
| O-12 | Connect Federico's existing 17 stdio MCPs. | Not implemented/proven. | Same evidence as O-11. |
| O-13 | Workers API Cloudflare health/preflight bypass. | Not implemented at edge. | Live `workers-api.floom.dev/healthz` and `OPTIONS /workers` from AX41 return Cloudflare `403`; audit evidence `/tmp/workeros-ui-round2/docs/audits/security-product-audit-2026-06-01.md:41-43`. |
| O-14 | E2B sandbox callback to Composio proxy not blocked by Cloudflare. | Not implemented/proven. | User-provided test transcript reports E2B egress IP blocked on `/runs/*/composio-execute/*`; same WAF class as O-13. |
| O-15 | Public OSS Next proxy user/session boundary. | Not implemented. | `/tmp/workeros-ui-round2/docs/audits/security-product-audit-2026-06-01.md:21`. |
| O-16 | Protect all stock/demo workers from destructive API deletion. | Incomplete. | Current protected set lacks `search_console_insights` and uses kebab `linkedin-post-engagements` at `/tmp/workeros-ui-round2/apps/api/main.py:246-268`; user-provided Round 2 report says production deletion occurred. |
| O-17 | Consolidate duplicate LinkedIn worker schemas. | Not implemented/proven. | User-provided Round 2 report: `workers/linkedin-post-engagements/` and `workers/linkedin_post_engagements/` conflict. |
| O-18 | Full telemetry collection implementation with privacy/export/delete. | Not implemented. | Requirement doc only: `/root/workeros-cloud/docs/TELEMETRY-DATA-COLLECTION-2026-06-01.md`. |
| O-19 | Product email system for welcome/notification emails. | Not implemented/proven in current Cloud product. | User asked to verify Vivek's code first; no verified Cloud email system evidence found in this lane. |
| O-20 | Privacy policy and data map updated for new telemetry. | Not implemented/proven beyond existing security/data docs. | Security audit says privacy policy/data map exist at `/tmp/workeros-ui-round2/docs/audits/security-product-audit-2026-06-01.md:49-51`; telemetry-specific disclosure remains open. |
| O-21 | Mobile 375px sweep. | Not implemented/proven. | Older Claude completeness audit lists mobile sweep as blind spot: `/root/workeros-cloud/engine/docs/audits/feedback-completeness-audit-2026-05-29.md:48`, `86-88`, `155-156`. |
| O-22 | Robots/favicons/OG assets. | Not re-verified in this lane; older audit listed open. | `/root/workeros-cloud/engine/docs/audits/feedback-completeness-audit-2026-05-29.md:38-40`, `155`. |
| O-23 | Run-detail infinite left scroll. | Not implemented/proven. | `/root/workeros-cloud/engine/docs/audits/feedback-completeness-audit-2026-05-29.md:62`, `89`, `132`. |
| O-24 | Folder-select row jump. | Not implemented/proven. | `/root/workeros-cloud/engine/docs/audits/feedback-completeness-audit-2026-05-29.md:64`, `90`. |
| O-25 | Internal test workers hidden from operator list. | Not implemented/proven. | Older audit says `env-vars-worker` / `node-smoke-test` leak: `/root/workeros-cloud/engine/docs/audits/feedback-completeness-audit-2026-05-29.md:74`, `91`, `144`. |
| O-26 | Worker cards not changing size on hover. | Not implemented/proven; repeated older and current complaint. | `/root/workeros-cloud/engine/docs/audits/feedback-completeness-audit-2026-05-29.md:56-57`, `123-124`; current ledger `/tmp/workeros-ui-round2/docs/FEEDBACK-LEDGER.md:226`. |
| O-27 | Workers not opening in new tabs. | Not implemented/proven after re-raise. | `/root/workeros-cloud/engine/docs/audits/feedback-completeness-audit-2026-05-29.md:60`, `150`. |
| O-28 | Tabs consistently use URL hashes. | Not fully proven. | Worker detail hash map exists at `/tmp/workeros-ui-round2/apps/web/app/workers/[id]/page.tsx:92-121`; older audit lists partial hash behavior at `/root/workeros-cloud/engine/docs/audits/feedback-completeness-audit-2026-05-29.md:149`. |

## Unclear / Needs Direct Verification

| ID | Item | Why unclear | Evidence |
| --- | --- | --- | --- |
| U-01 | Auto-deploy from GitHub to both Vercel projects. | User asked repeatedly; this lane did not inspect Vercel project settings or webhook events. | No Vercel API/browser evidence gathered in this lane. |
| U-02 | Vivek's latest pushes across both repos. | This lane used current local trees; it did not fetch remotes because other agents may be editing. | Current local SHAs recorded in scope; no remote comparison included. |
| U-03 | Cloud Supabase migrations applied in production. | Docs list migration requirements; DB credentials not used in this lane. | `/root/workeros-cloud/docs/WORKSPACE-TOKENS-2026-06-01.md:23-24`; `/root/workeros-cloud/docs/STATUS-SLACK-WORKSPACE-AGENT-DX-2026-06-01.md:20`. |
| U-04 | Cloud email/welcome notification system ported from another Floom project. | No verified current code evidence found in the inspected docs; another lane may own it. | User asked to verify Vivek's changes first. |
| U-05 | Slack authentication in Federico's browser. | Browser auth state not used in this lane. | Slack status doc verified only generic public/code capability. |
| U-06 | Gstack `/browse` installation and use. | Current environment has the `browse` skill available; this lane did not install or run it. | Skill list includes `browse` at `/root/.codex/skills/gstack-browse/SKILL.md`. |
| U-07 | Production Cloud version of asset versioning migrations. | Local migration/repo/API support exists; production DB state unverified. | `/root/workeros-cloud/supabase/migrations/0013_asset_versions.sql:1-30`. |
| U-08 | Product docs for virgin agents are "super clear" end-to-end. | Docs exist; no fresh virgin-agent test was executed in this lane. | User-provided virgin test scored deployment UX 65/100. |

## Top 20 Remaining Items

| Rank | Priority | Item | Why it ranks here | Evidence |
| --- | --- | --- | --- | --- |
| 1 | P0 | Fix feedback tracking/status drift. | Federico repeatedly re-raised items that ledgers marked done; this is causing missed work. | `/root/workeros-cloud/engine/docs/audits/feedback-completeness-audit-2026-05-29.md:169-179`. |
| 2 | P0 | Fix public OSS proxy auth/allowlist boundary. | Public deployment proxy currently injects the OSS secret across broad methods. | `/tmp/workeros-ui-round2/docs/audits/security-product-audit-2026-06-01.md:21`. |
| 3 | P0 | Fix Workers API Cloudflare health/OPTIONS and E2B callback blocking. | Monitoring, browser preflight, and sandbox callback paths are blocked before FastAPI from AX41. | Live checks in this report; `/tmp/workeros-ui-round2/docs/audits/security-product-audit-2026-06-01.md:41-43`. |
| 4 | P0 | Protect and restore stock workers including `search_console_insights`; consolidate LinkedIn duplicates. | User-provided audit reports real data loss; protected set still lacks `search_console_insights`. | `/tmp/workeros-ui-round2/apps/api/main.py:246-268`; user-provided Round 2 report. |
| 5 | P0 | Complete workspace scoping in production: tokens, switcher state, active workspace selection. | Cross-workspace credentials/data boundaries are product-critical. | `/root/workeros-cloud/docs/WORKSPACE-TOKENS-2026-06-01.md:3-24`; `/tmp/workeros-ui-round2/docs/FEEDBACK-LEDGER.md:234`. |
| 6 | P1 | Prove Slack end-to-end or label it not connected. | Current UI can imply Slack is connected while Slack event/channel loop is missing. | `/root/workeros-cloud/docs/STATUS-SLACK-WORKSPACE-AGENT-DX-2026-06-01.md:11-28`. |
| 7 | P1 | Fix Brain and Source file previews for XLSX/PDF/HTML/CSV/video and source files. | Latest screenshots show broken previews; raw/rendered promise is not met. | `docs/launch-readiness/agent-runs/screenshots/lane-b-workers-brain-xlsx-error-2048.png`; `/tmp/workeros-ui-round2/apps/web/components/worker-form/FilesEditor.tsx:342-370`. |
| 8 | P1 | Add Brain versions UI and make versioning visible for all mutable assets. | Backend exists but the user cannot see Brain version history. | `/tmp/workeros-ui-round2/apps/api/main.py:2113-2160`; no Brain version UI found. |
| 9 | P1 | Add edit mode for agent instructions and clarify Instructions vs Final prompt. | Instructions are editable by default and the distinction remains confusing. | `/tmp/workeros-ui-round2/apps/web/app/assistant/page.tsx:279-324`. |
| 10 | P1 | Show model declarations for workers and workspace agent. | User asked multiple times; no model field verified in UI. | `/root/workeros-cloud/docs/STATUS-SLACK-WORKSPACE-AGENT-DX-2026-06-01.md:21`; `/tmp/workeros-ui-round2/docs/FEEDBACK-LEDGER.md:237`. |
| 11 | P1 | Redesign MCP add/import around command-first workflows and stdio support. | Current UI is a generic form and excludes stdio-only configs. | `/tmp/workeros-ui-round2/apps/web/app/connections/mcp/page.tsx:245-350`. |
| 12 | P1 | Fix Connections rows: app + account, scopes, status, loading, Supabase post-auth clarity. | Latest screenshots still show cryptic account fragments and fake-feeling state. | `/tmp/workeros-ui-round2/docs/FEEDBACK-LEDGER.md:228-230`. |
| 13 | P1 | Fix overview fit and data coherence. | Latest screenshot shows cut-off card area and inconsistent queued/scheduled semantics. | `/tmp/workeros-ui-round2/docs/FEEDBACK-LEDGER.md:233`; current user screenshot. |
| 14 | P1 | Fix worker cards: icon parity with detail pages, top whitespace, hover stability. | Repeated visual issue across older and current feedback. | `/tmp/workeros-ui-round2/docs/FEEDBACK-LEDGER.md:226`; `/root/workeros-cloud/engine/docs/audits/feedback-completeness-audit-2026-05-29.md:56-57`. |
| 15 | P1 | Ship standalone/shareable approval pages. | In-app approvals exist; worker-spawned external page is missing. | `/tmp/workeros-ui-round2/docs/audits/security-product-audit-2026-06-01.md:23`. |
| 16 | P1 | Design workspace fork/share/transfer including secret handling. | Product/security-sensitive collaboration primitive remains open. | `/tmp/workeros-ui-round2/docs/FEEDBACK-LEDGER.md:235`. |
| 17 | P1 | Implement telemetry collection with privacy, export, delete, and redaction. | Requirement is documented but not productized. | `/root/workeros-cloud/docs/TELEMETRY-DATA-COLLECTION-2026-06-01.md`. |
| 18 | P1 | Complete granular per-worker connection permission review. | Structured allowlists exist, but no first-class review UI and legacy strings remain broad. | `/tmp/workeros-ui-round2/docs/audits/security-product-audit-2026-06-01.md:22`. |
| 19 | P2 | Complete naming sweep: apps -> connections, contexts -> Brain. | Partially shipped; legacy labels/hashes still exist. | `/tmp/workeros-ui-round2/apps/web/app/workers/[id]/page.tsx:102-120`; `/tmp/workeros-ui-round2/docs/FEEDBACK-LEDGER.md:238`. |
| 20 | P2 | Re-run mobile, robots/favicon, run detail, folder-select, internal-test-worker checks from the older Claude audit. | These were explicit older misses and not fully re-verified in this lane. | `/root/workeros-cloud/engine/docs/audits/feedback-completeness-audit-2026-05-29.md:80-93`. |

## Duplicate Notes From Prior Conversations

These were not one-off latest-session complaints. They repeat from earlier Claude/Codex sessions:

| Duplicate cluster | Repeated evidence |
| --- | --- |
| Feedback tracking itself is broken. | Older Claude audit states ledger claimed `65/72 shipped` but reality was closer to `33 truly-live, 25 with a real gap`: `/root/workeros-cloud/engine/docs/audits/feedback-completeness-audit-2026-05-29.md:13-26`. |
| "Merged" was treated as "done". | `/root/workeros-cloud/engine/docs/audits/feedback-completeness-audit-2026-05-29.md:169-172`. |
| Latest Federico re-raises were ignored. | `/root/workeros-cloud/engine/docs/audits/feedback-completeness-audit-2026-05-29.md:173-177`. |
| Dense screenshot messages dropped small UI bugs. | `/root/workeros-cloud/engine/docs/audits/feedback-completeness-audit-2026-05-29.md:177-179`. |
| Connections identity/scopes/reconnect were raised repeatedly before. | `/root/workeros-cloud/engine/docs/audits/feedback-completeness-audit-2026-05-29.md:35-37`, `116-120`. |
| MCP/studio import was raised repeatedly before. | `/root/workeros-cloud/engine/docs/audits/feedback-completeness-audit-2026-05-29.md:46-47`, `120-122`. |
| Overview design quality was raised repeatedly before. | `/root/workeros-cloud/engine/docs/audits/feedback-completeness-audit-2026-05-29.md:41-43`, `146-148`. |
| Worker card height/hover/icons were raised repeatedly before. | `/root/workeros-cloud/engine/docs/audits/feedback-completeness-audit-2026-05-29.md:56-57`, `123-124`. |
| Worker detail/edit/source/code problems repeated. | `/root/workeros-cloud/engine/docs/audits/feedback-completeness-audit-2026-05-29.md:50`, `66-67`, `125-127`. |
| Approvals standalone page repeated. | `/root/workeros-cloud/engine/docs/audits/feedback-completeness-audit-2026-05-29.md:54`. |
| Mobile/robots/favicon/CLI publish were older misses not represented in the headline ledger. | `/root/workeros-cloud/engine/docs/audits/feedback-completeness-audit-2026-05-29.md:80-93`, `155-158`. |
| The 2026-06-01 ledger itself reopens many items that older sections marked done. | `/tmp/workeros-ui-round2/docs/FEEDBACK-LEDGER.md:216-238`. |

## Process Correction For Future Lanes

For any future item marked done:

1. Include the exact repo commit, deployed URL, and timestamp.
2. Include a screenshot or live HTTP/API receipt that shows the changed state, not a loading state.
3. If Federico re-raises the same issue later, reopen the item even when an older PR exists.
4. Track Cloud overlay fixes separately from Workeros engine fixes, then sync via submodule pin.
5. For screenshot-heavy user messages, split every visible defect into its own backlog row before fixing.

## Verification

Read-only side-agent transcript audit completed and made no file changes. Code-evidence side-agent produced code references while running read-only. This document was created as the only intentional file change in this lane.
