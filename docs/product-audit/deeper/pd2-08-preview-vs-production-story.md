# pd2-08 — Preview vs production (mental model)

**Lens:** PRODUCT cloud default · ROADMAP shipped image tags · cross `pd-11`, `pd-14`, marketing domains.

## Executive truth table

| # | ICP question | Honest answer shape | Verdict |
|---|--------------|---------------------|---------|
| 1 | “Is preview ‘safe’ to try?” | Data residency, auth, billing parity | **Partial** — must be explicit in product copy |
| 2 | “Will my link change at go-live?” | URL / slug stability | **Partial** (product policy) |
| 3 | “Same code as self-host?” | Same image lineage (ROADMAP) | **Met** architecturally |
| 4 | “Do cookies cross subdomains?” | Session behavior for `preview` vs `app` hosts | **Partial** (implementation detail affects trust) |
| 5 | “Is rate limit stricter in prod?” | If different, say so | **Unknown** — document in ops, surface if user-visible |

## ICP failure tree

1. **User tests on preview, invites teammate on prod**  
   - *Breaks:* different accounts or apps.  
   - *Recovery:* workspace invite + environment badge in UI.

2. **Sentry / analytics on preview**  
   - *Breaks:* privacy worry.  
   - *Recovery:* consent copy alignment (`pd-13`).

3. **“Production” link in docs points to preview**  
   - *Breaks:* bookmark rot.  
   - *Recovery:* canonical host in README and `/protocol`.

## Risk register

| ID | Sev | Risk |
|----|-----|------|
| P1 | P2 | **Unlabeled environment** in UI → wrong assumptions about data durability |
| P2 | P2 | **Support confusion** (“which URL?”) without in-app host chip |
| P3 | P3 | **SEO** splitting between hosts if public pages exist on both |

## PM questions

1. Should every signed-in surface show a **fixed environment chip** (Preview / Production)?  
2. Is **data export** promised equally on preview and prod for paid tiers (future)?  
3. Do you publish a **single canonical** marketing domain in PRODUCT/README for ICP bookmarks?
