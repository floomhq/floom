# v6 Share-Page Build Plan

This plan implements the Federico-approved v6 share-page designs (signed-off spec:
`/tmp/workeros-designs-v6.html`) as real React in `apps/web`. Four public share surfaces are
reskinned to the v6 system: the worker share (`/w/[id]`), the run page (`/runs/[id]` via
`RunDetailSplitPane`), the brain file/pack share (`/s/[token]`, the standalone share card that
already serves `brain_file`/`brain_pack` entities and navigates like the in-app brain), and the
standalone approval surface (`/approvals/review`). The HARD design rules are: ONE card per share
surface (never a stack of cards that scroll the page); no page scroll — internal panes/tab-bars/
breadcrumbs swap content within a fixed-height shell; ALL share cards share the same fixed 480px
body height; output rendering is GENERIC (markdown→markdown, json→json, csv→table, text→text,
file→file) with no use-case-specific chrome or badges; no emoji anywhere; real brand logos only
(via the existing `BrandLogo`/IconSprite, never text-in-circles); Workeros branding (not "Floom").

The GENERIC output renderer is built ONCE as a shared primitive, `GenericOutput`
(`components/generic-output.tsx`), and reused by the run page, the approval surface, and the worker
example-result. It renders by declared type with no label/chrome wrapper, so the existing
`OutputRenderer` (which adds a per-field label header) is refactored to delegate its type-switch to
`GenericOutput` (DRY). Work proceeds surface by surface in the worktree `/tmp/workeros-v6-build`
(branch `feat/v6-share-pages`), committing + pushing after each surface: (0) shared `GenericOutput`
+ shared share-card primitives (`ShareCardShell`, fixed-height body, `WorkerosMark`), (1) worker
share flip-card with a top tab bar (run.py / SKILL.md / worker.yml) on the back face + pinned
"Add to workspace" CTA + noindex, dropping the old `npx ... add <token>` artifact, (2) run page —
output-first via `GenericOutput`, Files/Logs as tabs, Title-case statuses, Workeros branding, no
floating "MARKDOWN REPORT"/"Completed" badges, (3) brain file/pack share — content-first +
breadcrumb navigation within one fixed-height card, sticky "Add to workspace" CTA, (4) approval
surface — one fixed-height card showing the ACTUAL action items rendered generically + a bold
plain-language action line + approve/deny + noindex. Web `tsc --noEmit` and `next build` must be
green; ONE PR is opened at the end (no merge, no deploy).
