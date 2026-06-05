# Standalone Share Pages

Date: 2026-06-05

## Reference Studied

- Live reference: `https://floom.dev/s/fls_A7lOwwSGOct63FCNC_-4CWlryYf8VddxfTCRxsmVk10`
- Saved reference: `/tmp/floom-share-ref.html`
- Fetched copy: `/tmp/floom-share-live.html`
- Verification: both HTML files are 2,802,403 bytes.
- CSS inspected: `/tmp/floom-share-page.css` and `/tmp/floom-global.css`.

## Reference-Element Checklist

- 56px standalone top bar with brand on the left and one lightweight action link on the right.
- Full viewport background with centered share surface, max width about 452px, no authed app chrome.
- Sender strip at the top of the card with avatar initials, shared-by copy, and muted source/version metadata.
- Primary card body with a small status chip, square icon tile, compact H1, muted multiline description, and no oversized hero.
- Preview block inside the card using a mono heading and scroll-clamped mono content.
- Main CTA band with full-width primary button, read-only command/link line, small no-login reassurance, and footer metadata.
- Secondary inspection view for files/content with top header, horizontal file tabs, full code/content viewer, author footer, and safety note.
- Separate bottom CTA band below the card, compact and centered.
- Typography matching the reference hierarchy: sans body, mono details, restrained 26px desktop title, dense spacing.
- Workeros tokens and brand, reference layout proportions, border radii under 13px, line borders, quiet shadow, no decorative blobs.
- Mobile flow keeps the standalone card, removes 3D dependency, and preserves readable text and touch targets.
- Workeros share pages add `meta robots noindex,nofollow` and `X-Robots-Tag: noindex, nofollow`.

## Implementation

Unified share table:
- `standalone_share_links`
- Token namespace: `fls_...`
- Entity types: `worker`, `brain_file`, `brain_pack`
- Public route: `/s/<token>`
- API route: `GET /s/{token}`
- Download route for shared Brain files: `GET /s/{token}/download`

Noindex:
- API `GET /s/{token}` returns `X-Robots-Tag: noindex, nofollow`.
- API file downloads return `X-Robots-Tag: noindex, nofollow`.
- Next `/s/[token]` returns `robots: { index: false, follow: false }`.
- Web middleware adds `X-Robots-Tag: noindex, nofollow` and `Cache-Control: no-store` for `/s/*`.

Secret safety:
- Brain file and pack share creation scans content with the existing secret scanner.
- Public Brain file and pack reads re-scan content and fail closed if detected secrets appear after link creation.
- Public worker response remains an allow-list and excludes owner id, source files, secrets, webhook URLs, run history, and config internals.

## Per-Entity Status

Worker cards:
- Status: implemented.
- Share action: worker cards and worker detail header call `POST /workers/{id}/share-link`, then copy `/s/<token>`.
- Public page: renders worker name, description, trigger, runtime, tool logos via `BrandLogo`, example output or worker details, CTA, and inspection view.

Brain files:
- Status: implemented.
- Share action: file pane link button calls `POST /contexts/{name}/files/{path}/share-link`, then copies `/s/<token>`.
- Public page: renders file title, pack/source path, content preview, full source inspection, and download.
- Public download: implemented via same-origin `/s/<token>/download`.

Brain packs:
- Status: implemented.
- Share action: pack header link button calls `POST /contexts/{name}/share-link`, then copies `/s/<token>`.
- Public page: renders pack title, description or file count, file tabs, preview, and full content inspection.

## Verification

- Backend compile: `/usr/bin/python3 -m py_compile apps/api/main.py apps/api/models.py`
- Backend tests: `/usr/bin/python3 -m pytest apps/api/tests/test_standalone_share_public.py apps/api/tests/test_worker_share_public.py -q`
- Frontend tests: `npm run test`
- Frontend lint: `npm run lint`
- Frontend build: `npm run build`
- Route smoke: `BASE_URL=http://127.0.0.1:3131 SHARE_TOKEN=fls_d6y2nRHuHWqY3a9JfDku1DLq ops/smoke-routes.sh`
- Production browser QA: `/tmp/workeros-share-prod-qa-results.json`

Production browser screenshots:
- Worker desktop: `/tmp/workeros-share-prod-worker-desktop.png`
- Worker mobile: `/tmp/workeros-share-prod-worker-mobile.png`
- Brain file desktop: `/tmp/workeros-share-prod-file-desktop.png`
- Brain file mobile: `/tmp/workeros-share-prod-file-mobile.png`
- Brain pack desktop: `/tmp/workeros-share-prod-pack-desktop.png`
- Brain pack mobile: `/tmp/workeros-share-prod-pack-mobile.png`
- Brain pack inspection view: `/tmp/workeros-share-prod-pack-inspect-desktop.png`

Production browser QA confirmed:
- All worker, Brain file, and Brain pack share pages returned 200.
- Each share page emitted `X-Robots-Tag: noindex, nofollow`.
- Each share page emitted `meta name="robots" content="noindex, nofollow"`.
- Worker CTA rendered as `Run this worker`.
- Brain file CTA rendered as `Download file`.
- Brain pack CTA rendered as `View pack`.
- Copy-link and no-login copy rendered for every entity.
- Brain pack inspection view opened and rendered file tabs plus the public preview note.
- Browser console errors: none in production QA.
