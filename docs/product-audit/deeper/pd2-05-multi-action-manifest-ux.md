# pd2-05 — Multi-action manifest UX

**Lens:** PRODUCT same three surfaces per app · ROADMAP `primary_action` / PATCH hub (`pd` wave 1 ingest) · cross `pd-08`, `pd-05`.

## Executive truth table

| # | Product question | Expected behavior | Verdict |
|---|------------------|-------------------|---------|
| 1 | Default action when manifest has many keys | Sensible default + creator can pin | **Partial** — `primary_action` exists server-side; consumer clarity varies |
| 2 | Consumer discovers other actions | Tabs or clear secondary affordance | **Partial** |
| 3 | MCP / HTTP expose multiple tools or one | Parity with manifest | **Partial** (tool naming / discovery) |
| 4 | Wrong action run by mistake | Validation + clear labels | **Met** / **Partial** by client |
| 5 | Rename action in spec | Migration / confusion for saved runs | **Partial** (mostly operational) |

## ICP failure tree

1. **ICP runs `run` but wanted `summarize`**  
   - *Breaks:* identical-looking forms.  
   - *Recovery:* only if labels come from manifest titles, not keys only.

2. **Creator pins `primary_action` typo**  
   - *Breaks:* server rejects (good) but Studio error must explain fix.  
   - *Recovery:* list valid actions in UI (`hub` PATCH already returns `valid_actions`).

3. **MCP agent picks first tool alphabetically**  
   - *Breaks:* wrong business outcome.  
   - *Recovery:* tool descriptions must mention default vs secondary (`pd-18`).

## Risk register

| ID | Sev | Risk |
|----|-----|------|
| M1 | P2 | **Tab overload** on `/p/:slug` for 6+ actions without grouping |
| M2 | P2 | **Action key shown** to users instead of human `title` from manifest |
| M3 | P3 | **Version skew** between ingested manifest and docs the creator edited offline |

## PM questions

1. Should **`primary_action`** be editable in Studio UI without re-ingest everywhere?  
2. Do you cap **visible** actions on `/p/:slug` with “More…” after N?  
3. For MCP, should **one** “meta” tool describe all actions, or is one-tool-per-action mandatory?
