# WorkerOS App UI v4 — Implementation Spec

**For:** Vivek (implementation, app → main)
**Source of truth:** `docs/design/final.html` — the interactive wireframe. Open it, click everything. Every screen, modal and flow in this spec exists there (top banner → **Design index** catalogs all of them). Where this doc and the wireframe disagree, the wireframe wins; where the wireframe and the backend disagree, the backend wins and the gap has a `frontend-parity:` issue.
**Backend ground truth:** `ui-backend-coverage-2026-06-10.md` (master matrix) + the four `coverage-{A..D}-*.md` evidence docs. Every UI element is classified BUILT (endpoint cited file:line) / PARTIAL / MISSING (issue #).
**Aligned with v3 landing (PR #159):** workers are **jobs, not fake colleagues** — no persona names, no avatar monograms, output over mechanics. The app carries the same language.

---

## 0. The ten rules (read first)

1. **One Collection component.** Workers, Runs, Brain, Connections, Approvals, Settings are ONE component: header (title + counts) → toolbar (search, grid/list toggle, Add) → tag bar (multi-select filters) → grid OR list → 30/70 split detail on select. Build it once. No page gets a bespoke list.
2. **Flat by token, never by component.** All borders come from CSS variables (`--bd-card:none`, `--bd-pill:none`, `--bd-input:none`, `--bd-list:none`, `--bd-div:hairline`, `--bd-btn:none`). To change a surface class, change the token. A hardcoded `border: 1px solid` in a component is a review-blocker (this exact bug shipped twice during design).
3. **No fake identity.** No initials-chips/avatars for workers, runs, approvals, or any non-person. Avatars are for PEOPLE only (members, account). Semantic icons stay: brand logos for tools/connections, folder icons for Brain.
4. **Output first.** A worker's detail leads with its latest output (result + artifacts), then "what it does". The artifact is the product; the flow chart is explanation. (Issue #815 adds `last_run.output_preview` to the API.)
5. **One file-open pattern.** Files open INLINE with breadcrumb + viewer (Brain and Run outputs share it, identically). Never a popup for file content. Images render as images.
6. **No system UI.** Dropdowns, confirms, pickers are ours (`.csel` popover, confirm modal, picker modal). Native `<select>`/`alert()`/`confirm()` are banned.
7. **No dead buttons.** Every clickable does something — navigates, opens a modal, or gives inline feedback. If the real action isn't built, it opens an honest confirm-modal describing what will happen, or it doesn't ship.
8. **Visibility is quiet.** `private | workspace` only (NO "public" level — killed deliberately). Lists show a lock icon ONLY when private; workspace is the silent default. The full badge appears only in the detail header. Sharing = others can view & **duplicate** — never collaborate live.
9. **Calm, not alarmed.** Approvals are "waiting", grey, with a pause icon — never amber warning triangles. Status pills are the only colored elements on cards.
10. **Same size everywhere.** `.gcard` min-height is uniform (148px) across ALL collections so switching pages never jumps. Headers: nav-top and Emily header are both exactly 56px (the collapse chevrons must align).

---

## 1. Design tokens (copy verbatim from final.html `:root`)

```
--bg-app:#FBFBFC; --bg-card:#FFFFFF; --bg-2:#F3F4F6; --bg-3:#ECEDF0;
--ink:#16171A; --ink-soft:#3a3b40; --muted:#6B7280;
--line:rgba(16,17,20,.09); --line-soft:rgba(16,17,20,.055);
--primary:#16171A; --success:#2F8F5B; --warning:#E5533D; --pending:#C98A1A;
--info:#3E6FE0; --accent:#3E6FE0; --sel:#EEF3FE;
--r-card:16px; --r-btn:10px; --r-pill:9999px; --shadow:none;
/* border system — adjust globally here, never per-component */
--bd-card:none; --bd-pill:none; --bd-input:none; --bd-list:none;
--bd-div:1px solid var(--line-soft); --bd-btn:none;
```
Dark mode mirrors the palette (see `body.dark` in final.html). Font: Geist / Geist Mono. Buttons: secondary = filled `--bg-2` (no outline), primary = `--primary` fill, danger = red-tinted fill. Search inputs = `--bg-2` fill, no border. Tags/chips = `--bg-2` fill pills. Tag bar fades out at its right edge (CSS mask), no hard cut.

## 2. Layout shell

Three panes: **nav (228px, collapsible to 62px icon rail)** · **center (flex)** · **Emily rail (330px, collapsible to 46px; widen 560px; full-screen)**.

- **Nav top = workspace identity** (company logo + workspace name + chevron-on-hover). Click → switcher popover: workspaces list, New workspace, **Share workspace / Duplicate workspace** (backend BUILT: `/workspace/share-link`, `/workspaces/{id}/duplicate`). Note: multi-workspace listing is OSS-mode; Cloud needs a branch (see coverage-D).
- **Nav bottom = account row, always pinned** (flex `min-height:0` on the scroller — this had a real bug). Click → menu: Settings, Toggle theme, Log out. Email shown as label.
- Nav items: Overview, Workers, Brain, Runs, Approvals (pending-count badge ← `GET /approvals/count`), Connections. ⌘K search (global search endpoint is #806; ship client-side first).
- **Deep links:** `#workers`, `#runs`, `#brain`, `#connections`, `#approvals`, `#settings`, `#overview` set the initial page.
- **Mobile (first pass, in wireframe):** <880px both rails auto-collapse, tiles 2×2, cards stack, list rows simplify to name+status, split detail takes full width. A real mobile product (bottom tabs, Emily as sheet) is explicitly NOT in this scope.

## 3. The Collection component

Open `final.html` → Workers for the canonical instance.

- **Header:** H1 + one-line sub + counts strip (keep counts minimal: e.g. "8 workers · 1 needs attention").
- **Toolbar:** search (`--bg-2` pill, ⌘K hint), grid/list segmented toggle (`--bg-2` track, white active), black Add button.
- **Tag bar:** `all` + smart group (starred/recent/archived) + **access group (private | shared)** + status group + content tags. Multi-select; right-edge fade. Workers/Brain get the access group; Runs/Approvals do NOT (owner-scoped in backend — a filter there would lie). Server-side: archived BUILT; starred is #782; visibility filter is #771; search is #779 (client-side until then).
- **Grid cards:** name + (lock if private) → 2-line description → footer: status pill + tool brand logos. min-height 148px. Hover = bg lift, no border/shadow.
- **List rows:** 64px, hairline dividers, NO outer container border. Columns per page (see final.html). Quiet `⋯` overflow at the right.
- **Split detail (30/70):** left list becomes a narrow connected list (rows show name + context line — for Runs that line is `duration · time · status`); right is the detail: 56px header (icon/logo + title + badges + actions + ⋯ overflow + close), tab strip, body. The detail header for approvals shows the TOOL brand logo (HubSpot etc.) — brand consistency everywhere.

## 4. Per-page specs (deltas only — everything else is the Collection)

### Overview
4 hoverable, clickable metric tiles (runs 7d, runs today, workers active, coming up) with sparklines + per-day hover tooltip that follows the cursor (`8 · Mon`). Data: `GET /system/overview` (BUILT — incl. `runs_7d_sparkline`, activity feed, coming-up list). Below: Worker activity + Coming up as contained flat lists. Tiles navigate (runs/workers).

### Workers
Detail tabs: **Overview · History (count) · Source · Versions · Config**.
- **Overview = output-first:** "Latest output" (result text + artifact chips + All runs →) THEN "What it does" flow (#815 for the API field).
- **History:** recent runs w/ durations, link to Runs.
- **Source:** file segmented tabs (worker.yml / SKILL.md / run.py / requirements.txt) + Edit (in-app editor; stock workers clone-on-edit — `PUT /workers/{id}/files` BUILT). Stock note shown.
- **Versions:** git log in the GLOBAL list style — message + `sha · author · age`, current marker, Diff (modal) + Restore (confirm). `GET /workers/{id}/versions` + rollback BUILT.
- **Config:** Tools (add/edit → picker; routes through worker-YAML PUT until #790) · Brain attach w/ read-only|read-write (`writeable` flag BUILT) · Triggers (manual/schedule cron+tz/webhook URL — BUILT; "paused" = `enabled:false`, there is no paused status; pause/resume endpoint is #788) · Limits (tokens/timeout/approval policy BUILT; spend cap #793).
- Actions: Run (inputs modal → run trigger BUILT), Edit (name/desc → #785), ⋯ (Versions, Share, Duplicate BUILT, Delete). Member view: Feedback (#731) / Duplicate / Request edit access (#807); server enforces visibility scoping (BUILT) — but see SECURITY #804.

### Runs
List grouped by day, trigger/duration/status/started columns. Detail tabs: **Output · Trace · Inputs · Raw**.
- Output = result + files; **files open inline** (breadcrumb `Output / file`, Back, Download); **PNG artifacts render as images**; nested artifact dirs expand in place. Artifacts + download BUILT; single-run ZIP BUILT.
- Trace: steps w/ durations (derive from transcript timestamps — no structured field), logs.
- Header: `↑ worker` link (worker_id on every run — BUILT) + Open worker / Share / Replay (`/runs/{id}/replay` BUILT). Run share link itself is #765 (designed, backend pending). Bulk export #796.

### Brain
Folders w/ file count + updated (BUILT). Detail: Files (nested dirs — tree endpoint #783; SQLite .db table viewer #777; markdown rendered client-side), file viewer inline w/ breadcrumb, Edit, Download; **drag-drop**: grip handles appear on row hover only (never always-on), dashed drop-zone for upload (multi-file upload BUILT; move/rename #770). "Used by" reverse list BUILT. Share folder = same share modal.

### Approvals
Calm: grey "N items · waiting" pills, no amber. Detail tabs Request / Items / Run.
- Request: kv (worker → clickable link, requested-at, why-paused) + **type-aware preview**: email draft (To/Subject/Body), CRM record diffs table, task list. Backend sends `preview` as a string today — type field is #792; render heuristically until then.
- **Comment box on approve AND reject** (reject reason BUILT; approve comment #769; annotations BUILT).
- Run tab: link to paused run, steps-so-far, cost-so-far (#795). NO expiry copy (approvals don't expire — #798).
- Share approval = BUILT (`public_link`, public approve/reject routes). Standalone approval page: calm header w/ tool logo, proposed action, kv, comment, Approve/Reject.

### Connections
One list, Type is a tag (Connection/MCP/Key — secrets unified is #786). Status pills from health sweep (BUILT). Detail per type w/ Test (BUILT)/Reconnect/Remove/Activity (BUILT)/account-info (BUILT). OAuth connect modal: WorkerOS mark ⇢ app logo, "requested access" list, note that exact scopes are confirmed on the provider's consent screen (Composio can't expose them pre-auth). MCP live tool enumeration #789; last-used-at #802.

### Settings
TWO groups with labels: **Workspace · {name}** (System, Channels, Assistant, Members, Version history, Danger) and **Account · {user}** (Developer, Appearance). Counts "6 workspace · 2 account".
- System: workspace kv (rename/region/tz are #791) + **Cursor-style toggle rows** (iOS switch, title+desc left): approval-default / auto-pause / failure-emails (#794) + model defaults & limits & spend cap (#797).
- Channels: Slack (status BUILT) · Email (**"Not connected"** — no email channel exists yet, #787/#799) · WhatsApp (status #781/#801) · "Install WorkerOS in your agent" (multi-agent grid: Claude/Cursor/Codex/VS Code/Windsurf/Cline + MCP config + PAT mint BUILT; rotate #784).
- Assistant: Base / Workspace instructions / Final prompt (all BUILT incl. composed prompt + versions + rollback). **SECURITY: server-side member guard on PUT /workspace[/base] is missing — #804. Do not ship member UI before that lands.**
- Members: list/invite/role/remove/transfer — ALL BUILT.
- Version history: combined workspace changelog in global list style (per-asset endpoints BUILT; merged timeline #772).
- Danger: Export (BUILT) / Delete workspace (#805).
- Appearance: theme seg (per-user persistence #773 — client-side until then).

### Emily rail
**DO NOT hand-build the chat UI.** Federico's call: Emily will be prompt-kit-native React. The wireframe defines only: placement (right rail), collapse/widen/full behavior, 56px header (avatar + green dot + fullscreen + ⋯ menu with New chat/Export/Recent chats), composer (paperclip + input + send), suggestion chips, create-worker mode ("Describe the job in one sentence…", banner: "Your previous chat is still running — find it in Recent chats"). Backend: SSE `POST /chat`, conversations list/reopen, `POST /workers/new/from-prompt` ALL BUILT; recent-chats wiring #775, export #776, attachments #778.
**Chat internals (#825):** tool calls render with the EXISTING collapsible `ai-elements/tool.tsx` (click → inputs/outputs/status — same component as run details; EmilyChat's flat `tool-card` parts get replaced); approvals appear INLINE in the thread (card + comment + Approve/Reject via existing API); Emily's answers link to app pages as real router hrefs (generalize `getAutoOpenRunDetailsHref`). NO DOM access / page driving — links only.

## 5. Modals & standalone pages (all in Design index)

**Modals:** Share (Drive pattern: invite input → people list → General access custom dropdown [Private|Workspace] → Public-link toggle "view & duplicate" → footer Copy link / **Open** / Done — works for worker, brain folder, system prompt, run, approval, workspace; grants #767, access-list #768, link toggle #766) · Run-with-inputs · Edit worker · OAuth consent · Slack install · WhatsApp QR · Agent install · Confirm (generic, used for every destructive/stub action) · Diff · Tool/Brain picker.

**Standalone (recipient-facing, top WorkerOS bar + centered card + footer):**
- Worker share page: name, shared-by, tool logos (top-right ONLY — no duplicates), what-it-does kv, latest result, **Duplicate to my workspace** (import-from-share BUILT) + **Download as skill** (#816) + Sign in.
- **Run share page**: result, files, steps w/ timings, links back to the worker (#765 for backend).
- Approval page: calm "Waiting for your review" + tool logo + preview + comment + Approve/Reject (public routes BUILT).
- **Channel-first onboarding** (#817): landing → "Start in Slack / Start in WhatsApp", dashboard optional. New flow, design in wireframe, backend issue filed (depends #762/#733/#800).

## 5a2. Sign-in + workspace creation (Federico 2026-06-10)

- **Sign-in page is split** (Design index → "Sign-in page"): LEFT = dark product-proof panel (mark, "Hire AI workers.", a real-looking "This week" artifact card — show what they get, never a bare form); RIGHT = form (email magic-link primary, GitHub/Google secondary, "your first sign-in creates one"). Industry pattern; no boring centered card.
- **New workspace modal**: ONE company field — typing it fetches the company logo automatically (favicon/logo service) and prefills the workspace name; name stays overridable (one company can run several workspaces). Smooth, not bulky: two fields + live logo preview, nothing else. Backend: workspace create BUILT; storing company domain + logo needs a field (extend #791).
- **Casing: it's "WorkerOS"**, never "Workeros", in every user-visible string (#824). Package/identifiers stay lowercase.

## 5a3. Shipped on the live landing meanwhile (2026-06-11) — do not re-do

- workeros-cloud PR #166: **/v3/about Manifesto page** (manifesto copy is VERBATIM-SACRED — never edit it), bridge photo + small-caption bridge quote, footer About + GitHub + LinkedIn (linkedin.com/company/floomhq confirmed; X handle still withheld).
- workeros-cloud PR #167: the 7 landing polish fixes — incl. inline tool logos (closes #823), artifact-card rhythm (closes #822), and the **WorkerOS** casing on the landing (#824's landing half; the app half lands with this v4 build).
- The landing lives in **floomhq/workeros-cloud** — never add landing pages to this repo (a wrong-repo rebuild was closed as workeros#896).

## 5b. Landing ↔ App continuity (Federico 2026-06-10)

- **One design system.** Landing and app share the tokens in §1 (palette, radii, flat border system). Theme: day/night/system exists on the landing exactly like in the app, same storage key, carried across the transition (#820 — theme toggle half SHIPPED in PR #160, `floom-theme` key is canonical).
- **Sign-in as late as possible.** The landing's "Works without the dashboard too: Slack, WhatsApp, or any MCP agent" row routes to the INSTALL FLOWS directly (Slack install / WhatsApp QR / MCP config) — never to sign-in (#819). Full anonymous provisioning is #817; #552 (install-after-sign-in) is the interim inverse.
- **Session-aware CTA.** Already authenticated → landing nav says "Dashboard", not "Sign in" (#821).

## 5c. Mobile status (verified 2026-06-10)

First-pass responsive is IN the wireframe and verified at 390px across Overview, Workers, Runs, Brain, Approvals, Settings: rails auto-collapse to icon bars (<880px), tiles 2×2, cards single-column, list rows reduce to name + context, split detail takes full width, modals fit (94vw). The v3 landing is separately mobile-certified (375px, all 5 page types, PR #159).
**Explicitly out of scope here:** bottom tab bar, Emily as a swipe-up sheet, 44px touch-target audit, gesture work. That is a dedicated mobile pass — do not block the desktop implementation on it, but keep the <880px CSS working (definition of done includes a 390px render check per page).

## 6. Backend contract — the law

Implement ONLY against endpoints marked BUILT in `ui-backend-coverage-2026-06-10.md`. Everything else has an issue number — reference it in code comments (`// TODO(#788): pause/resume endpoint`) and ship the honest fallback (hide, disable-with-tooltip, or client-side equivalent). **Never assume a backend change that isn't an accepted issue.**

Open issue ledger (all `frontend-parity:` on floomhq/workeros): #765–#773, #775–#796 (odd subset, see master doc), #798–#807, #815 output preview, #816 download-as-skill, #817 channel-first onboarding. Security: **#804 first.**

## 7. Definition of done (per page)

A page is done when: (1) it visually matches final.html in light AND dark, admin AND member; (2) every button does something real or honest; (3) all data comes from BUILT endpoints (no mocks left); (4) gaps carry `TODO(#issue)`; (5) it passes the wireframe's interaction set (open Design index, click through the page's flows); (6) member-mode restrictions are enforced by the SERVER response, not just hidden in UI.
