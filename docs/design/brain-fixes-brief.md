# Brain / context fixes — brief (2026-06-05)

Federico live-walk. The brain (context packs + files) is broken and unintuitive. Engine = source of truth; the Cloud has its own context routes (managed-deployment/apps/api/routes/context_previews.py) + Supabase repos. Fix in engine where the logic is shared; cloud-only where it is a cloud repo/route. Investigate ROOT CAUSE before patching. Do NOT prod-deploy without ops/smoke-routes.sh.

## M85a (P0) brain attach throws HTTP 500 on Cloud
Reproduce attaching a file to the brain on Cloud (workeros.floom.dev). Capture the 500's server traceback (cloud API logs / the request). Root-cause it (likely the cloud Supabase context repo or storage path differs from engine; or a missing pack/context row; or a storage bucket/permission issue). Fix at root. Verify attach succeeds live on Cloud.

## M85b download a brain file -> {"detail":"Context not found"}
Clicking download on a brain file returns detail "Context not found". Trace the download endpoint (apps/api/main.py + managed-deployment context_previews.py). The context/file exists (it is listed) but the download lookup misses it — likely id/slug/workspace-scoping mismatch (same class as the M74/M75 stale-workspace bug) OR the download route resolves the wrong id. Fix so download returns the file. Verify live.

## M85c drag-drop auto-create pack
Dropping a file into the brain should JUST WORK even when no pack exists yet: auto-create a pack, auto-name it (sensible default, e.g. from the filename or "My brain"), and put the file in it. Today the user cannot just drop a file (there must be a pack first). Make the drop flow create-the-pack-if-needed. UI + backend.

## M85e brain is read-only -> add WRITE
The brain/context is currently read-only. Federico wants to add/edit files (write). Add the write path: upload/create/edit/delete files in a pack, with the proper API + UI. (Pairs with M85c.)

## Out of scope here (separate sharing lane)
The standalone noindex share LINKS for files/packs (M85d) + matching the Floom reference design are handled by the standalone-share lane — do NOT build share pages here; just make sure the data model supports a shareable file/pack (a share token per file + per pack) and coordinate.

## Discipline
Worktree off origin/main, commit+push each step, PR (admin merge if GH Actions billing-blocks, after local tests). Run ops/smoke-routes.sh before any prod deploy. No secret values. No em dashes in UI strings. Write docs/BRAIN_FIXES_2026-06-05.md with per-item root cause + status.
