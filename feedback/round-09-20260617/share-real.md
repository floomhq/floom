# Share real (round-09) — the REAL Share experience

Branch `feat/share-real-r9` (off `origin/feat/worker-detail-real-r9`), repo `floomhq/workeros`.
Not merged to main. Commits: `e2a5bc4d` (share modal + wiring + tests), `ac02c693` (preview harness).

## What was wrong (the "wasn't there more logic?")

The backend share machinery is fully live but the UI shipped as a bare "copy link":
- Worker detail "Share" = a dropdown item that POSTed a share-link and copied it to the clipboard. No visibility, no grants, no revoke, no link state.
- Run detail "Share" = a `#765` "coming soon" toast.
- `components/sharing/ShareModal.tsx` existed but was used NOWHERE, and its public-link toggle was hardcoded `disabled` with "Backend pending #766" — even though `#766` backend (create + revoke) is live.
- `ShareWorkerButton` / `WorkerVisibilityControl` orphaned.

Backend that actually exists (verified by reading routers/services):
- Visibility: `PUT /workers/{id}/visibility` (+ brain pack + assistant), returns `permissions.can_share`.
- Specific-people grants `#767/#768`: `POST/GET /share/grants`, `DELETE /share/grants/{id}`.
- Public standalone share-link `#765/#766`: `POST/DELETE /workers/{id}/share-link`, same for `/runs/{id}`, `/contexts/{name}` (pack), `/contexts/{name}/files/{path}` (file). Public page at `/s/<token>`, short-link `/w/<short_id>`.
- Approval: `ApprovalRow.public_link` (a deterministic signed review URL).

Key backend constraint that drives the UX: the share-link table stores ONLY `sha256(token)` (`#934`). So `POST` is **create-or-ROTATE** (re-POST mints a new token, old URL dies), `DELETE` revokes, and **there is NO GET** — you cannot read whether a link is active or recover an existing URL. The honest UI can only know the URL it minted in the current session.

## STEP 1 — Codex consult (verbatim design)

Prompt written to a file, run with `codex exec --cd <clone> - < prompt.md`. Codex inspected ShareModal, AssetVisibilityControl, share-model, api.ts, the share-link service/routes, grants routes, and approval public-link code, then returned this design (verbatim):

> **Decision:** Rewrite `components/sharing/ShareModal.tsx` in place. Replace the "copy link footer + disabled checkbox" model with a real access modal.
>
> Order: 1. Title `Share "{name}"` 2. `Inside your company` 3. `Public link` 4. footer `Done`. No avatars, no colored borders, no amber warning box. Plain text, quiet dividers, accent only on links and primary action.
>
> **Inside your company** — Header `Inside your company`. Invite row placeholder `Add teammate by email`, button `Invite`, empty line `No teammates invited yet.`, owner line `You`. Access selector label `Company access`; `Private` summary `Only you and invited teammates can view and duplicate this.`; `Workspace` worker-summary `Transfers this worker to the workspace. Members can view and run it; admins configure secrets and connections.`, non-worker `Everyone in the workspace can view and duplicate this.` Worker transfer confirmation: title `Transfer worker to workspace?`, body `This moves ownership to the workspace. You lose edit access. An admin must configure connections and secrets before the worker can run.`, `Cancel` / `Transfer to workspace`. Never present sharing as collaboration — use `view and duplicate`.
>
> **Public link** — Do not use a checkbox. The backend is create-or-rotate and has no GET. The honest model is an action panel. Unknown: body `Create a public link for people outside your workspace…`, subtext `Creating a new link disables any previous public link for this item.`, button `Create public link`. Active-known: status `Public link active in this browser session`, buttons `Copy`/`Open`/`Revoke`, subtext `This is the only time Workeros can show this exact URL. Save it before closing this browser session.` Revoked: status `Public link revoked`, button `Create new link`. Revoke confirmation: `Revoke public link?` / `Anyone using this link will lose access. You can create a new link later.` / `Cancel` / `Revoke link`. **Do not show expiry** — backend has no expiry column; a disabled control adds noise and implies roadmap commitment.
>
> **Public link state machine:** `unknown -> creating -> active_known`; `active_known -> revoking -> revoked`; `revoked -> creating -> active_known`. Any failed action returns to the previous stable state + toast. Reopening after full reload starts at `unknown`. Never label unknown as "off" or "no link exists".
>
> **Prop interface:** generalized `ShareModalProps` over `asset {type,id,name}`, `companyAccess {visibility, setVisibility, grantAsset}`, `publicLink {create, revoke?, staticUrl?, label?}`.
>
> **Per asset:** Worker = both sections, grants `worker`, workspace requires transfer confirm, scope `They can view the worker, inspect its files, and duplicate it.` Run = both sections, grants `run`, no workspace visibility unless caller supplies a setter, scope `They can view this run, including inputs, steps, tool calls, output, and cost.` Library = pack `brain_pack` / file `brain_file`, grants `brain`. Approval = no grants, no workspace, use `ApprovalRow.public_link`, label `Decision link`, body `Anyone with this link can review, approve, or reject this pending approval.`, buttons `Copy`/`Open`, **no revoke** because the approval link is a deterministic HMAC, not the rotate/revoke table.
>
> **Implementation notes:** add revoke helpers to `api.ts` for worker/run/brain pack/file + a run create helper; add `"run"` to `StandaloneShareLink.entity_type`; remove `SHARE_GAPS.publicLinkToggle` (backend is live).

I verified Codex's per-asset claims against the code before building (e.g. `ApprovalRow.public_link` exists; grants backend accepts `asset_type=run`).

## STEP 2 — What was wired (real components + APIs)

- `apps/web/components/sharing/ShareModal.tsx` — rewritten to Codex's generalized prop interface (`asset` / `companyAccess` / `publicLink`). Two sections ("Inside your company", "Public link") with a quiet `Separator`. Public link is the honest state machine (`unknown | creating | active | confirm_revoke | revoking | revoked`); a `staticUrl` shortcut for approval's deterministic HMAC link (no revoke). Inline worker→workspace ownership-transfer confirmation before the PUT. All copy is Codex's. Design-compliant: no borders (the design system sets `--bd-input: none`), no avatars, no amber, accent only on the link URL.
- `apps/web/lib/sharing/share-model.ts` — removed stale `SHARE_GAPS`; added `publicLinkScope(type)` (per-asset copy) and `ShareAssetType` / `ShareGrantAssetType`.
- `apps/web/lib/api.ts` — added `workers.revokeShareLink`, `runs.shareLink`, `runs.revokeShareLink`, `contexts.revokePackLink`, `contexts.revokeFileLink`.
- `apps/web/lib/types.ts` — `StandaloneShareLink.entity_type` now includes `"run"`.
- `apps/web/app/workers/WorkersCollection.tsx` — worker detail "Share" dropdown item now opens the real `ShareModal` (visibility + grants + public link + revoke), replacing the bare copy-link.
- `apps/web/app/runs/RunsCollection.tsx` — new `RunShareButton` (owns its modal state); the run detail "Share" opens the real modal (anonymous public link + revoke), replacing the `#765` "coming soon" toast.
- Tests: `share-model.test.ts`, `share-grants-767.dom.test.tsx`, `share-transfer-warning.dom.test.tsx` updated to the new prop shape + new transfer-confirmation behavior. **10/10 pass.** `tsc --noEmit` clean on all touched files (the only remaining tsc errors are pre-existing in `secure-cookie-cache-927-941.test.ts` and `login-route-g1.test.ts`, both untouched). ESLint 0 errors. `lint:emdash` / `lint:borders` / `lint:tokens` all pass.

## How it generalizes (run / library / approval)

The SAME `ShareModal` adapts purely via props, no per-type forks:
- **Run**: pass only `publicLink` (no `companyAccess`) → public-link-only modal, run-specific scope copy. (Grants for a run are possible — backend accepts `asset_type=run` — but not wired into the run UI yet; see gaps.)
- **Library item**: pass `companyAccess` (pack visibility via `/contexts/{name}/visibility`, grants `asset_type=brain`) + `publicLink` (pack vs file revoke helpers exist). No transfer confirmation because it isn't a worker. (Brain UI wiring not done in this PR; the modal + APIs are ready.)
- **Approval**: pass `publicLink.staticUrl` + `label="Decision link"`, no `revoke` → static link, Copy/Open only. (Approval UI wiring not done in this PR.)

## STEP 3 — Preview + screenshots I read myself

Preview harness route `apps/web/app/preview/share/page.tsx` renders the modal in all four scenarios, gated public by `PREVIEW_HARNESS=1` (never public in prod). Served locally (`next dev`), driven with gstack `/browse` (broker MCP down). I READ every PNG (`feedback/round-09-20260617/share-shots/`):

| Shot | State | Verdict (read) |
|---|---|---|
| `01-worker-private.png` | Worker, private | PASS. "Inside your company" (invite + `morten@floom.dev` grant + You), Private active w/ check, Workspace, summary, divider, Public-link section + "Create public link", Done. Clean, no clutter. |
| `02-worker-transfer-confirm.png` | Worker → Workspace clicked | PASS. "Transfer worker to workspace?" with ownership-loss body + Cancel / "Transfer to workspace" in a quiet bg block (no amber/border). PUT does not fire until confirm (unit-tested). |
| `04-worker-revoke-confirm.png` | Public link → Revoke clicked | PASS. URL shown in accent, "Revoke public link?" + "Revoke link" in destructive red, Cancel quiet. |
| `05-run.png` | Run | PASS. Public-link-only (no company section), run scope copy "inputs, steps, tool calls, output, and cost". |
| `06-brain-pack.png` | Brain pack, workspace | PASS. Workspace active, "Anyone in the workspace can view and duplicate this", brain-pack scope, NO transfer confirmation (correct — not a worker). |
| `07-approval.png` | Approval | PASS. "DECISION LINK" label, static URL shown directly (no create step), "review, approve, or reject" copy, no revoke (correct — HMAC link). |

**Active public-link state (`active`):** verified by DOM inspection during the walk — after "Create public link", `data-slot=dialog-content` contains the `fls_…` URL plus `Copy` / `Open` / `Revoke` buttons and the honest "This is the only time we can show this exact URL" note. The earlier element screenshot I read showed exactly this. I could NOT get a stable PNG of this one specific state because base-ui's Dialog portal de-paints on the public-link re-render in headless gstack (the modal stays open in the DOM — `dialogs:1`, url present — but the screenshot races the portal repaint). This is a headless-harness artifact, not a component defect: the unit tests + DOM checks confirm the state-machine logic, and the revoke-confirm shot (`04`) shows the active row (URL + Revoke) underneath the confirmation.

## Honest gaps

1. **Active-link screenshot** is DOM-verified, not PNG-captured (base-ui portal repaint race in headless gstack). Not a logic bug.
2. **Run/library/approval UI wiring not shipped here** — the generalized modal + all API helpers are ready, but only the **worker** and **run** surfaces open the modal in this PR. Brain pack/file and approval Share entry points are a follow-up (small: same modal, props already designed). Surfacing this rather than silently claiming "all surfaces done".
3. **Run grants** are backend-capable (`asset_type=run`) but the run modal is public-link-only by choice (Codex: grants only when a real setter exists); add `companyAccess.grantAsset` to `RunShareButton` if owner-scoped run grants are wanted.
4. **No GET for link state** is a backend reality, not fixed here. The modal is honest about it ("active in this browser session", "only time we can show this URL"). If persistent link-state display is wanted, the backend needs a `GET …/share-link` returning `{active: bool, created_at}` (would NOT return the token, only existence).
5. **Preview harness** (`/preview/share` + `PREVIEW_HARNESS` flag) is committed for QA. Remove it before any production merge if you don't want a preview route in the tree.

## Preview URL

Local: `http://localhost:3457/preview/share` (run `PREVIEW_HARNESS=1 next dev` in `apps/web`). The brief's `r9-detail.floom.dev` harness is a separate deploy target; this PR adds the share-modal preview route it would serve.
