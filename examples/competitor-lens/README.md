# Competitor Lens

Compare exactly two HTTPS URLs: your page and one competitor page. The app fetches both pages with a hard 5s / 500KB cap, extracts the main text, and returns one structured JSON object with:

- `positioning_diff`
- `pricing_diff`
- `unique_angles`

`GEMINI_API_KEY` is optional for local demos. If it is missing, the app returns a deterministic dry-run stub. The baked-in `sample-cache.json` gives `/p/competitor-lens` an instant precomputed result for `https://floom.dev` vs `https://n8n.io`.

## Example curl

Run the FastAPI surface locally:

```bash
cd examples/competitor-lens
uvicorn main:app --reload
```

Then call it:

```bash
curl -X POST http://127.0.0.1:8000/analyze \
  -H 'content-type: application/json' \
  -d '{
    "your_url": "https://floom.dev",
    "competitor_url": "https://n8n.io"
  }'
```

Or use the CLI/Floom runner contract directly:

```bash
python3 main.py '{"action":"analyze","inputs":{"your_url":"https://floom.dev","competitor_url":"https://n8n.io"}}'
```
