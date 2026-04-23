# Lead Scorer

Floom's hero demo app. CSV of leads in, scored rows out with reasoning.

**Model:** Gemini 3 Flash (`gemini-3-flash-preview`) by default for fast demo runs. Override with `GEMINI_MODEL=gemini-3.1-pro-preview` (or pass a `model` input) for deeper reasoning. Both use native web search + URL context grounding. Not Claude. Not Gemini 2.x.

**Instant sample responses:** The baked-in `sample-cache.json` returns a pre-generated Pro-quality response in under 500ms when the user submits the exact sample CSV + ICP. Any other input hits Flash live. See [cache regeneration](#regenerating-the-sample-cache) below.

## What it does

1. Reads a CSV from `/floom/inputs/data.csv` (or any path you pass).
2. For each row, sends the lead + your ICP to Gemini 3. Gemini uses live web search and URL context to research the company.
3. Returns a 0-100 fit score, 2-3 sentence reasoning, and enriched fields (industry, employee range, country, buy signal).
4. Runs 8 rows in parallel inside the container (ThreadPoolExecutor).
5. Fails soft: one bad row returns `score: null, reasoning: "scoring_failed"` instead of crashing the batch. Rate limits retry once.

## Inputs

| Input | Type | Required | Description |
|-------|------|----------|-------------|
| `data` | `file/csv` | yes | Path to a CSV file. Any columns, header row required. |
| `icp`  | `textarea` | yes | Free-text description of your ideal customer. |

## Outputs

```jsonc
{
  "total": 10,
  "scored": 9,
  "failed": 1,
  "dry_run": false,
  "cache_hit": false,
  "model": "gemini-3-flash-preview",
  "rows": [
    {
      "#": 1,
      "company": "Acme Fintech GmbH",
      "website": "https://...",
      "status": "ok",
      "score": 87,
      "reasoning": "German fintech (~120 employees) with CFO contact matches the ICP directly. Recent Series B signals active spend.",
      "enriched_fields": {
        "industry": "fintech",
        "employee_range": "100-200",
        "country": "DE",
        "signal": "Series B funding announced 2025-Q4"
      }
    }
    // ... sorted by score desc, unscored rows last
  ],
  "score_distribution": {"80-100": 2, "60-79": 4, "40-59": 3, "20-39": 1, "0-19": 0, "unscored": 0}
}
```

## Run locally

### Build
```bash
docker build -t floom-lead-scorer -f examples/lead-scorer/Dockerfile examples/lead-scorer
```

### Run (with real Gemini key)
```bash
docker run --rm \
  -v "$PWD/examples/lead-scorer/test-input.csv:/floom/inputs/data.csv:ro" \
  -e GEMINI_API_KEY="$GEMINI_API_KEY" \
  floom-lead-scorer \
  '{"action":"score","inputs":{"data":"/floom/inputs/data.csv","icp":"European fintech CFOs at 50-500 employee companies"}}'
```

### Dry run (no key — returns random scores for UI demos)
```bash
docker run --rm \
  -v "$PWD/examples/lead-scorer/test-input.csv:/floom/inputs/data.csv:ro" \
  floom-lead-scorer \
  '{"action":"score","inputs":{"data":"/floom/inputs/data.csv","icp":"EU fintech CFOs"}}'
```

Output is printed to stdout. The last line is prefixed with `__FLOOM_RESULT__` (Floom runner convention — see `apps/server/src/lib/entrypoint.py`).

## Sample input

See [`test-input.csv`](./test-input.csv) — 8 real B2B companies: 5 European fintech scale-ups (Ramp, Pennylane, Qonto, Payhawk, Spendesk) plus 3 deliberate misfits (industrial manufacturer, design agency, biotech). Paired with an ICP like "B2B SaaS CFOs at 100-500 employee fintechs in EU", the fit leads should score high and the misfits low — a real demo of the scorer's signal.

## Regenerating the sample cache

`sample-cache.json` freezes a Pro-quality response for the exact pre-filled sample on `/p/lead-scorer`. When the user submits that exact input (same CSV bytes + same ICP), `main.py` returns the cached blob in <500ms instead of calling Gemini.

Regenerate after changing `apps/web/public/examples/lead-scorer/sample-leads.csv` or the sample ICP in `apps/web/src/lib/app-examples.ts`:

```bash
GEMINI_API_KEY=... python3 scripts/gen-demo-cache.py lead-scorer
```

The canonical input contract lives in `canonical_input()` at the top of `main.py`: SHA-256 of the CSV bytes + whitespace-normalized ICP, JSON-encoded with sorted keys. Any change to the sample CSV or ICP invalidates the cache key and needs a regeneration run.

## Design notes

- **`file/csv` contract**: Per `WORKPLAN-20260421-file-inputs-root-fix.md`, the Floom runtime will materialize uploaded CSV files to `/floom/inputs/<input_name>.<ext>` and pass the path string in the JSON. This app reads from that path. If the runtime plumbing hasn't shipped and you pass raw CSV text instead of a path, the app falls back to parsing it inline.
- **No Claude, no OpenAI, no Gemini 2.x.** Enforced in code. `gemini-3.x` only.
- **Model override**: `GEMINI_MODEL` env var (operator) or `model` input (creator) lets you swap Flash → Pro without code changes.
- **Robust scoring**: one retry on rate-limit / transient errors, then soft-fail that row. The batch always completes.
- **Parallelism**: 8 workers inside the container. Tune via `MAX_WORKERS` constant in `main.py`.
