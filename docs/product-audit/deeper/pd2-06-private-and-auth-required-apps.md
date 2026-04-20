# pd2-06 — Private and auth-required apps (who can run?)

**Lens:** PRODUCT three surfaces + same manifest · ROADMAP visibility · cross `pd-05`, `pd-11`, `pd-15`.

## Executive truth table

| # | Promise | Consumer mental model | Verdict |
|---|---------|------------------------|---------|
| 1 | **Public** app | Anyone can run from web/MCP/HTTP with rate limits | **Met** (baseline) |
| 2 | **Auth-required** app | Must sign in (or session) before run | **Partial** — parity across surfaces must stay in lockstep |
| 3 | **Private** app | Owner + explicit rules; not directory-listed | **Partial** — directory filtering vs deep link vs MCP discovery |
| 4 | Same rules in cloud and OSS | OSS `local` synthetic user changes who “counts” as owner | **Partial** (`pd-11`) |
| 5 | “I shared a link” does not bypass visibility | Share + visibility interaction | **Partial** (`pd-06` wave 1) |

## ICP failure tree

1. **ICP sends HTTP POST without session**  
   - *Breaks:* 401/403 without “open in browser to sign in”.  
   - *Recovery:* doc link or JSON `hint` field pattern.

2. **MCP client has no cookie**  
   - *Breaks:* auth-required app fails while web works.  
   - *Recovery:* bearer / API key story for cloud (product decision).

3. **Hub hides app but slug guessed**  
   - *Breaks:* run attempt vs leak of existence (404 vs 403 policy).  
   - *Recovery:* consistent “probe resistance” story across HTTP and web.

4. **Creator toggles visibility**  
   - *Breaks:* old bookmarks, cached hub tiles.  
   - *Recovery:* cache-bust + clear in-app “no longer public” for creator.

## Risk register

| ID | Sev | Risk |
|----|-----|------|
| V1 | P0 | **Semantic mismatch** between surfaces on auth-required → perceived security bug |
| V2 | P1 | **Existence leakage** via different status codes between web and API |
| V3 | P2 | **ICP confusion** between “private app” and “my run is private” |

## PM questions

1. For **auth-required**, is MCP officially “session bearer only” or do you ship a **pat** token model?  
2. Should **slug guessing** return uniform 404 for private apps on all surfaces?  
3. Does **permalink** change behavior when app becomes private (hard 404 vs owner message)?
