# Convergence deploy — brief (2026-06-06)

Goal: ship the batch of verified-but-undeployed work to live Cloud (workeros.floom.dev) + OS (workers.floom.dev) in ONE smoke-gated pass. You (Codex) own the merge/deploy decisions. Be careful: live multi-tenant Cloud. Use the smoke gate. Federico is NOT the reviewer — decide and execute, flag only genuine blockers.

## PRs to reconcile + merge (verify each is current + de-duped first)
- #449 feat(emily-chat): the REAL chat (frontend reskin + wired SSE + label polish). This is the canonical chat. #434 and #435 are older chat prototypes — CLOSE them in favor of #449 (confirm #449 supersedes).
- #455 standalone share pages (v2, matches the Floom reference).
- #450 M79 apex bare-path redirects (/connections/* -> /app/*).
- #448 M80 remove Composio redirect 3s delay.
- #436 MCP-JSON default — RECONCILE with already-merged #456 (Fix MCP JSON add flow and account email). If #456 already covers it, CLOSE #436; else merge the delta only.
- #458 stabilize proxy route exports (the Next 16 brain-500 proxy fix).
- connections-detail (M82 actions / M81 row / M84 picker) — confirm merged; if open, include.
- #452 M78: guided channels — DROP the Composio channels entirely (Slack + WhatsApp are native: Slack via the real app, WhatsApp via Meta Cloud API). Keep nothing Composio-channel. If the only value left in #452 is the Composio approach, close it; if it has a non-Composio useful piece (e.g. the Overview entry point), keep just that.

## Steps
1. Reconcile/de-dupe the PRs above (close superseded, resolve conflicts), merge the verified set to OS main (admin merge if GH Actions billing-blocks, after local build/test pass per PR).
2. Bump the Cloud engine submodule to the new OS HEAD; cd web && npm run sync && npm run check-drift && build.
3. Deploy: Cloud dashboard (web/ context, vercel --prod via token, project managed-deployment-dashboard) + bump/restart the Cloud API (managed-deployment-api) if the engine moved for it; OS frontend auto-deploys on main (verify) + deploy OS API via /opt/workeros-api-deploy/ops/deploy-api.sh + clean restart if backend changed.
4. RUN ops/smoke-routes.sh (the committed gate) — MUST pass (no 508/5xx) on both OS + Cloud. If it fails, do NOT promote; fix or roll back.
5. VERIFY LIVE each fix: workeros.floom.dev/app != 508; /connections/browse now redirects (not 404); the Emily chat dock renders + a test message streams; a share /s/<token> page renders + noindex; MCP add is JSON-first; the Composio redirect is instant. Capture evidence.
6. Keep web/vercel.json absent; keep engine integrity; never print secret values.

## Output
docs/CONVERGENCE_DEPLOY_2026-06-06.md: which PRs merged/closed, the deployed SHAs/dpl ids, smoke-gate result, and the per-fix live verification. Report done or the exact blocker.
