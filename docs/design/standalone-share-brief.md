# Standalone share pages — brief (2026-06-05)

the operator gave this feedback BEFORE and it was not delivered — he is frustrated. Do it properly this time, built against his REFERENCE.

## The ask
He wants TRUE standalone share pages (noindex), like the approvals shareable links (M12), for:
- **Worker cards** (M86) — sharing a worker currently looks "weird".
- **Brain files** (M85d) — share an individual FILE standalone (today you can only share a pack, and even that just links back to the platform).
- **Brain packs** (M85d) — share a pack as a real standalone page too.

"Standalone" means: a public, **noindex** (X-Robots-Tag: noindex + meta) page at a share URL (token-based, like approvals) that renders the content itself, NOT a redirect/link back into the authed platform. Anyone with the link sees the page; it is not search-indexed.

## THE REFERENCE (match this design)
https://floom.dev/s/fls_A7lOwwSGOct63FCNC_-4CWlryYf8VddxfTCRxsmVk10
A copy of the HTML is at /tmp/floom-share-ref.html (may be large; also FETCH the live URL to inspect the real rendered design — layout, hero, title, description, sections, CTA, footer, the standalone feel). The worker-card share page (and the brain file/pack share pages) must LOOK and FEEL like this Floom standalone share page. Study it first; list the design elements you will replicate (hero, content blocks, CTA, branding, typography, spacing). Match the Workeros design system tokens but the LAYOUT/structure should mirror the reference.

## Build
1. A unified standalone-share mechanism: a share token per shareable entity (worker, brain file, brain pack), a public `/s/<token>` style route (noindex), and a "Share" action in the UI that generates the link (like the approval share link).
2. The share PAGE design matches the Floom reference for each entity type:
   - Worker share: name, what it does, trigger, tools (with brand logos), example/last result, a clean CTA. No authed chrome.
   - Brain file share: the file content/preview, title, source, download.
   - Brain pack share: the pack overview + its files.
3. noindex on all share pages (X-Robots-Tag + meta robots noindex), like the brain-unindexed-links requirement (M70).
4. The "Share" UI on worker cards + brain files + packs produces the standalone link and copies it.

## Discipline
First FETCH + study the reference and write the element list you will match (so this is not ignored again). Worktree off origin/main, commit+push each step, PR (admin merge if GH Actions billing-blocks, after local tests). Run ops/smoke-routes.sh before any prod deploy. No secret values. No em dashes in UI strings. Match the design system + use real brand logos (BrandLogo), no text-in-circles. Write docs/STANDALONE_SHARE_2026-06-05.md including the reference-element checklist + per-entity status.
