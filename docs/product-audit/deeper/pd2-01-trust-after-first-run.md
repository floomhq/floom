# pd2-01 — Trust after the first run

**Lens:** `docs/PRODUCT.md` (ICP, three surfaces, hosting promise) · `docs/ROADMAP.md` (runs, async, history) · cross `pd-16`, `pd-14`, `pd-05`.

## Executive truth table

| # | Promise (PRODUCT / ROADMAP) | Reality (product read) | Verdict |
|---|----------------------------|-------------------------|---------|
| 1 | ICP should not need “ops literacy” to trust the system | Run history, share, and retention are split across `/me`, `/p/:slug`, APIs — cognitive load for “where is my stuff?” | **Partial** |
| 2 | Three surfaces for the same app | Same run may be discoverable via web vs HTTP poll vs MCP context with different affordances | **Partial** |
| 3 | Long-running work is a differentiator (ROADMAP) | Async UI “in flight” vs backend shipped — first run may not show job UX at all | **Partial** |
| 4 | User-visible errors should recover trust (ROADMAP polish) | Generic or internal codes after first run → ICP may assume “I broke it” | **Partial** |
| 5 | Self-host vs cloud same image (ROADMAP) | OSS `local` identity story vs session — first-run trust differs by mode | **Met** (architecture) / **Partial** (communication) |

## ICP failure tree

1. **First run succeeds, then user refreshes**  
   - *Breaks:* run id only in client memory or URL fragment.  
   - *Sees:* blank or new empty state.  
   - *Recovery:* `/me` or history link if they know it; else **dead end** (“did Floom lose my data?”).

2. **User shares a link**  
   - *Breaks:* share semantics vs private app / redaction not understood.  
   - *Sees:* 404 vs redacted output — looks like “bug” if not copy-explained.  
   - *Recovery:* only if copy says “owner vs viewer” (`pd-06`).

3. **Async app: user closes tab**  
   - *Breaks:* no clear “still running / check email / poll URL” story in UI.  
   - *Sees:* silence.  
   - *Recovery:* webhook or poll URL for power users — **not ICP-default**.

4. **Auth expires mid-session**  
   - *Breaks:* next action fails with auth error.  
   - *Sees:* jargon.  
   - *Recovery:* sign-in again if message is plain; else **dead end**.

## Risk register

| ID | Sev | Risk |
|----|-----|------|
| T1 | P1 | Post-first-run **trust cliff** if history and share are not obvious from the surface they used to run |
| T2 | P2 | Async + first-run without **one sentence** of expectation → perceived flakiness |
| T3 | P2 | Cross-surface **wording drift** (“run”, “job”, “execution”) erodes confidence |

## PM questions

1. After first success, what is the **single primary CTA** (history, share, iterate)?  
2. Should **permalink** always show “last run” vs “new run” default for returning users?  
3. For async, what is the **ICP-grade** promise when the tab closes (in-app sentence, not docs)?
