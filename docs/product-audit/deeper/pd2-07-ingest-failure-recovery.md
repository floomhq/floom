# pd2-07 — Ingest failure recovery (detect → publish)

**Lens:** PRODUCT path 3 OpenAPI vs primary repo path · ROADMAP ingest P0 · cross `pd-07` (wave 1), `pd-04`, `pd-19`.

## Executive truth table

| # | Stage | ICP-appropriate recovery | Verdict |
|---|-------|---------------------------|---------|
| 1 | **Detect** (spec preview) | Explains “what Floom understood” without RFC language | **Partial** |
| 2 | **Ingest** network / URL | Clear “cannot reach URL”, retry, check access | **Partial** |
| 3 | **Slug collision** | Suggestions + edit path (hub returns structured 409 in modern flow) | **Met** / **Partial** by UI wiring |
| 4 | **Invalid OpenAPI** | Pointer to field vs wall of JSON | **Partial** |
| 5 | **Success then hub stale** | Immediate visibility in directory | **Partial** — cache invalidation story (`pd-19` area) |

## ICP failure tree

1. **Spec behind auth**  
   - *Breaks:* 401 from origin; Floom cannot fetch.  
   - *Sees:* opaque error.  
   - *Recovery:* “Paste raw spec” or “public URL only” copy.

2. **Detect works, ingest fails**  
   - *Breaks:* ICP thinks detect lied.  
   - *Recovery:* single idempotent narrative: “preview ≠ publish”.

3. **Large spec timeout**  
   - *Breaks:* spinner then failure.  
   - *Recovery:* “try smaller slice” or async ingest (future) — must be honest.

4. **Wrong repo branch**  
   - *Breaks:* wrong OpenAPI in repo.  
   - *Recovery:* out of scope for Floom unless you add branch picker (PM).

## Risk register

| ID | Sev | Risk |
|----|-----|------|
| I1 | P1 | **Two-step confusion** (detect vs ingest) without one-sentence product copy |
| I2 | P2 | **Slug collision** emotional peak — if UI buries suggestions, abandon rises |
| I3 | P2 | **OpenAPI jargon** in errors returns ICP to “this is for developers” |

## PM questions

1. After a failed ingest, do you **preserve** detect results in UI for retry edits?  
2. Is **upload spec file** a first-class ramp equal to URL paste for ICP?  
3. For slug collision, is **auto-suggested slug** one-click or must user type?
