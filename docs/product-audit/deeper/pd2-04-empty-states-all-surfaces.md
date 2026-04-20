# pd2-04 — Empty states across surfaces

**Lens:** PRODUCT three surfaces · ROADMAP “UI stub / in flight” · cross `pd-16`, `pd-09`, `pd-08`.

## Executive truth table

| # | Surface / area | Empty state expectation | Verdict |
|---|----------------|-------------------------|---------|
| 1 | **Hub / store** | “No apps yet” vs curated seed — ICP understands what to do next | **Partial** (depends on seed + copy) |
| 2 | **`/me` (signed in)** | Clear primary: create app, run demo, connect account | **Partial** |
| 3 | **Studio / build** | Paste URL vs repo tile — must match ROADMAP priority | **Partial** (`pd-02`, `pd-19`) |
| 4 | **MCP tool list (admin)** | Empty = “no apps ingested” + one ingest instruction | **Partial** |
| 5 | **App detail (creator)** | Tabs for triggers/renderer/memory when backend exists but UI stub | **Partial** (ROADMAP: stubs) |

## ICP failure tree

1. **Hub shows apps but none “mine”**  
   - *Breaks:* ICP thinks they are in wrong account.  
   - *Recovery:* “Your apps” / workspace hint.

2. **Studio shows OpenAPI first**  
   - *Breaks:* ICP without API thinks product is wrong fit.  
   - *Recovery:* repo CTA parity (`pd-04` wave 1).

3. **Backend feature exists, UI empty**  
   - *Breaks:* “Is it broken or not shipped?”  
   - *Recovery:* explicit “Coming soon” with **what works today** (API/MCP) vs silence.

4. **MCP: `list_apps` empty**  
   - *Breaks:* agent concludes Floom empty.  
   - *Recovery:* tool description should say “ingest first” (`pd-18`).

## Risk register

| ID | Sev | Risk |
|----|-----|------|
| U1 | P1 | **Silent stub** reads as broken — worse than a labeled placeholder |
| U2 | P2 | **Inconsistent empty** patterns between web and docs |
| U3 | P2 | **No demo app** in empty hub → higher bounce for cold traffic |

## PM questions

1. Is there a **single empty-state component system** (title, body, primary CTA, secondary link)?  
2. For every ROADMAP “UI stub” feature, is the **intended** message “use API for now” or “wait”?  
3. Should the hub **always** show at least one runnable first-party demo for zero-auth users?
