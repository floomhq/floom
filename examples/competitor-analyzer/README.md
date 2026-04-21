# Competitor Analyzer

Paste a list of competitor URLs, get back a positioning, pricing, and strengths/weaknesses table. One Gemini 3 call per URL, fanned out 8-wide, grounded in the live web via Gemini's **URL context** tool plus **Google Search**.

## What it does

- **Input**: a list of competitor homepages and a one-line description of your own product.
- **Output**: a JSON table, one row per competitor, plus a short comparative summary of where you fit vs. them.

Every row cites the source URLs Gemini actually fetched, so you can verify claims.

## Why Gemini 3 (not Claude / GPT)

- **URL context** is a native Gemini 3 tool. Gemini fetches the page itself, so there is no scraper, no headless browser, no proxy.
- **Google Search grounding** fills the gaps when a homepage hides pricing behind "Contact sales".
- Flash or Pro 3 only. No Gemini 2.x, no Claude, no GPT. The manifest and code enforce this (startup hard-fails if `GEMINI_MODEL` is not `gemini-3*`).

### Picking the model

- Default: `gemini-3-flash-preview` (fast, high free-tier quota, good enough for homepage reads).
- Paid tier or deep reasoning: set `GEMINI_MODEL=gemini-3-pro-preview` or `gemini-3.1-pro-preview`.

### Free-tier escape hatch

`google_search` grounding sits on a stricter free-tier quota. If you see 429s when running under a free key, set `DISABLE_GOOGLE_SEARCH=1` and the app will use `url_context` only. Pricing behind "Contact sales" walls will show as `Unknown`, but homepage-level positioning still works.

## Inputs

| Field | Type | Description |
|-------|------|-------------|
| `urls` | `array` of strings | Competitor homepages. `https://` is added if missing. Duplicates are stripped. |
| `your_product` | `textarea` | One-line description of your product, used so strengths/weaknesses are comparative, not generic. |

## Output

Per competitor (`competitors[]`):

```json
{
  "url": "https://linear.app",
  "company": "Linear",
  "positioning": "Purpose-built issue tracking for modern software teams.",
  "pricing": "Free + $8/user/mo Standard + $14/user/mo Plus + Enterprise",
  "target_market": "Product and engineering teams at startups and scale-ups",
  "strengths": ["Keyboard-first UI", "Fast sync", "Opinionated workflow"],
  "weaknesses": ["Limited to software teams", "Thin reporting", "Weak PM integrations"],
  "source_citations": ["https://linear.app", "https://linear.app/pricing"]
}
```

Plus `summary` (one paragraph) and `meta.analyzed` / `meta.failed` counts.

If a URL cannot be fetched after one retry, that row becomes `{"url": "...", "error": "fetch_failed"}`. The batch continues.

## Running locally

### Dry-run (no API key) — for UI demos

```bash
cd examples/competitor-analyzer
docker build -t floom/competitor-analyzer:latest .
echo '{"action":"analyze","inputs":{"urls":["https://linear.app","https://notion.so"],"your_product":"Issue tracking for autonomous agents"}}' \
  | docker run --rm -i floom/competitor-analyzer:latest -
```

The app detects the missing `GEMINI_API_KEY` and returns a mocked payload with `meta.dry_run: true` so the UI still has something to render.

### Live run

```bash
docker run --rm -i \
  -e GEMINI_API_KEY="$GEMINI_API_KEY" \
  floom/competitor-analyzer:latest \
  '{"action":"analyze","inputs":{"urls":["https://linear.app","https://notion.so"],"your_product":"Issue tracking for autonomous agents"}}'
```

Or with the JSON on stdin:

```bash
echo '{"action":"analyze","inputs":{...}}' \
  | docker run --rm -i -e GEMINI_API_KEY=... floom/competitor-analyzer:latest
```

## Concurrency, retries, failure mode

- `ThreadPoolExecutor`, up to 8 workers. Each URL is one Gemini call; URLs are independent.
- One retry per URL. If both attempts fail, the row is marked `fetch_failed` and the batch continues.
- A second Gemini call produces the comparative summary from the successful rows.
- If zero rows succeed, the summary is a short "could not analyze" note instead of crashing.

## Secrets

Manifest lists `GEMINI_API_KEY` under `secrets_needed`. Floom injects it as an env var at run time. The container never reads `.env` files or writes the key to disk.

## Example output (abbreviated)

```json
{
  "competitors": [
    {
      "url": "https://linear.app",
      "company": "Linear",
      "positioning": "Purpose-built issue tracking for software teams.",
      "pricing": "Free + $8/user/mo + $14/user/mo + Enterprise",
      "target_market": "Startups and scale-ups, eng + product",
      "strengths": ["Keyboard-first UX", "Fast sync", "Clean API"],
      "weaknesses": ["Software-only focus", "Light reporting"],
      "source_citations": ["https://linear.app", "https://linear.app/pricing"]
    },
    {
      "url": "https://notion.so",
      "company": "Notion",
      "positioning": "All-in-one workspace for notes, docs, and tasks.",
      "pricing": "Free + $10/user/mo + $18/user/mo + Enterprise",
      "target_market": "Teams of all sizes wanting a unified workspace",
      "strengths": ["Flexible blocks", "Large template library", "AI add-on"],
      "weaknesses": ["Performance on large workspaces", "Weak native project views"],
      "source_citations": ["https://notion.so", "https://www.notion.so/pricing"]
    }
  ],
  "summary": "Both competitors cluster around seat-based pricing in the $8-$18/user/mo range with free tiers for discovery. The clearest opening for an agent-native issue tracker is programmatic / API-first workflows, which Linear has only partially and Notion lacks. The strongest threat is Linear's velocity and brand heat in the software-team ICP.",
  "meta": { "analyzed": 2, "failed": 0, "dry_run": false, "model": "gemini-3-pro-preview" }
}
```
