# Landing Copy

Generate modern landing-page hero copy from a short product idea.

This demo follows the same runner contract as other Python examples in this repo:
JSON in on `argv[1]`, `__FLOOM_RESULT__` JSON out on stdout.

## Inputs

- `app_idea` (required): 20-500 chars, 1-2 sentences
- `audience` (optional): 0-100 chars; inferred when omitted

## Output fields

- `h1`
- `sub`
- `bullets` (3 items: `{ label, copy }`)
- `primary_cta`
- `secondary_cta`
- `social_proof_line`
- `alternates` (2 H1 options)

## Behavior

- One Gemini 2.5 Flash Lite call (`gemini-2.5-flash-lite`)
- Strict JSON schema response
- Banned buzzword enforcement (`AI-powered`, `leverag*`, `revolutioniz*`, `transform*`, `robust`, `seamless`, `cutting-edge`, `next-gen`)
- Canonical sample fixture in `sample-cache.json`
- Deterministic dry-run response when `GEMINI_API_KEY` is missing

## Run locally

```bash
cd examples/landing-copy
pip install -r requirements.txt

# Quick mode (raw text arg)
python3 main.py 'A tool for ops teams to score inbound leads against their ICP using AI.'

# Floom config mode
python3 main.py '{"action":"generate","inputs":{"app_idea":"A tool for ops teams to score inbound leads against their ICP using AI."}}'
```

## Status

Prepared but not yet registered in launch demo seed data.
