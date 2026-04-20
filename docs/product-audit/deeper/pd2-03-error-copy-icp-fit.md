# pd2-03 — Error copy vs ICP (non-dev readability)

**Lens:** PRODUCT ICP sentence · ROADMAP polish / reliability · cross `pd-14`, `pd-07`, `pd-05`.

## Executive truth table

| # | Expectation for ICP | Typical failure mode in API-first products | Verdict |
|---|----------------------|---------------------------------------------|---------|
| 1 | Errors say **what to do next** in plain language | JSON `{ error, code }` surfaces raw to UI or toast | **Partial** (depends on client mapping) |
| 2 | Same error across web / HTTP / MCP feels consistent | MCP tool errors vs HTTP body shape differ | **Partial** |
| 3 | Auth errors invite sign-in without blame | “Unauthorized” reads as user fault | **Partial** |
| 4 | Rate limit errors show **wait**, not “broken” | 429 without retry guidance | **Partial** |
| 5 | Ingest/detect failures explain slug/spec | Good when copy lists suggestions (hub ingest); elsewhere varies | **Partial** |

## ICP failure tree

1. **`floom_internal_error` or 500**  
   - *Breaks:* no distinction “our bug” vs “your input”.  
   - *Sees:* “Something went wrong” with no next step.  
   - *Recovery:* support path unclear for free ICP → **trust hit** (`pd-14`).

2. **403 on private app**  
   - *Breaks:* “Forbidden” without “sign in” vs “you cannot access”.  
   - *Sees:* dead end.  
   - *Recovery:* sign-in CTA only if message names visibility.

3. **OpenAPI validation errors**  
   - *Breaks:* field paths (`#/paths/...`) exposed.  
   - *Sees:* intimidation.  
   - *Recovery:* top-level human line + “details for support” accordion.

4. **MCP `isError: true`**  
   - *Breaks:* agent summarizes badly; raw JSON is the product.  
   - *Sees:* loop of retries.  
   - *Recovery:* stable `code` + one `message` sentence for agents to quote.

## Risk register

| ID | Sev | Risk |
|----|-----|------|
| E1 | P1 | **Jargon leakage** on first failure → ICP abandons before second try |
| E2 | P2 | **Inconsistent codes** across surfaces → support and docs cannot stabilize |
| E3 | P2 | **No “copy for support”** affordance on fatal errors → longer time-to-resolution |

## PM questions

1. Is there a **canonical error taxonomy** (10–15 codes) documented for writers and UI?  
2. Should every 4xx/5xx in the **web app** map to a human string (never raw `code` alone)?  
3. For MCP, do you want a **required** `user_message` field separate from `debug`?
