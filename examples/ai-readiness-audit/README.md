# AI Readiness Audit

Paste one public HTTPS company URL and get a strict JSON audit back:

- `readiness_score` from `0` to `10`
- `score_rationale` in 1-2 sentences
- `risks` with exactly 3 items
- `opportunities` with exactly 3 items
- `next_action` as one concrete sentence

Input is server-side validated: exactly one URL, HTTPS only, max 200 chars, and
private / loopback / RFC1918 addresses are rejected before fetch. Live runs use
`gemini-3-pro`. If `GEMINI_API_KEY` is unset, the app returns a deterministic
stub so the demo still works.

## Run locally

```bash
docker build -t floom-ai-readiness-audit -f examples/ai-readiness-audit/Dockerfile examples/ai-readiness-audit

docker run --rm \
  -e GEMINI_API_KEY="$GEMINI_API_KEY" \
  floom-ai-readiness-audit \
  '{"action":"audit","inputs":{"company_url":"https://floom.dev"}}'
```

## Example curl

```bash
curl -sX POST http://localhost:3051/api/ai-readiness-audit/run \
  -H 'content-type: application/json' \
  -d '{"action":"audit","inputs":{"company_url":"https://floom.dev"}}'
```
