# Self-walk score sheet — 2026-05-28

Walked every page myself via the AX41 broker. Reference bar is /runs/<id> at 88 (the operator's gold standard). Average ~71. Honest scores below; S29q has shipped the top fixes from this list.

## Top-level surfaces

| Page / subpage | Score | What pulled it down |
|---|---|---|
| `/` (home) | **73 → 78 post-S29q** | KPI cards still bordered (S29q drops them); Recent runs + Scheduled today were stacked bordered Cards (S29q flattens) |
| `/workers` (list) | **65** | 4 filter rails (tabs + categories + tags + search) on one screen; card grid feels dashboard-y |
| `/workers/<id>#overview` | **68** | Header is OK; Example input renders as a nested table; Technical details collapsible decent |
| `/workers/<id>#run` | **76** | Form flat, but Audience + Depth selects stack instead of side-by-side |
| `/workers/<id>#triggers` | **83** | Cleanest worker subpage; segmented control + subtitle + action bar |
| `/workers/<id>#code` (Source) | **70** | File rail too narrow; reading view cramped |
| `/workers/<id>#runs` (History) | **42 → ~80 post-S29q** | Was BROKEN: raw run.id as title AND duplicated below; "completed" pill on every row. S29q routes through RunStatusBadge + uses relative time + meta |
| `/workers/<id>#connections` (Apps) | **64** | Quiet empty state; needs data-rich state walk |
| `/workers/new` | **76** | Post-S29o left-aligned + prominent back-nav; Examples grid still feels like a saturated CTA wall |
| `/runs` | **70 → 78 post-S29q** | Was 5 saturated blue status filter pills (S29q quiets to underline) + 2 filter rows |
| `/runs/<id>` (REFERENCE) | **88** | TIMELINE SMALL-CAPS (S29q drops); 3 header buttons (Edit + Re-run + Download) slightly heavy. Otherwise the model |
| `/connections` (Connected) | **78** | Clean. 4 action icons per row is busy |
| `/connections#browse` | **75** | Post-S29p Connect → outline fixed the 30-saturated-blues. Grid still dense |
| `/connections#secrets` | **72** | Same chrome as Connected; no separate walk artifact |
| `/settings#api` | **75** | Boxed tabs (fixed S29p); "Your Floom token" bordered card is the only bordered block → inconsistent |
| `/settings#system` | **73** | 2 bordered cards stacked |
| `/settings#appearance` | **68** | Theme card with one button; the card border is the whole page |
| `/settings#danger` | **78** | Bordered danger card is correct (the one place a Card belongs) |
| `/cli-auth` | **68** | Centered card around a 4-line form; card adds nothing |

## Shipped in S29q (PR #109)

1. History tab rebuild — relative time title + meta + RunStatusBadge
2. /runs status filters → quiet underline
3. /runs/<id> TIMELINE label dropped
4. Home KPI cards flat (no border)
5. Home Recent runs + Scheduled today as sections (no Card)
6. Home Needs attention keeps one ring as the only alarm-state block

## Still on the punch list (queued for S29r+)

- **/workers list**: collapse 4 filter rails into 1
- **/workers/<id>#overview**: Example input nested-table look → flat key-value
- **/workers/<id>#run**: Audience + Depth side-by-side
- **/workers/<id>#code**: wider file rail + roomier content
- **/settings**: drop the Card around "Your Floom token" so all sister tabs match (none bordered except Danger)
- **/cli-auth**: drop Card around 4-line form
- **/connections row**: collapse 4 action icons into a … overflow
- **/connections/browse**: collapse category row + search into one filter row

Re-walk after S29q to re-score and confirm the moves landed.
