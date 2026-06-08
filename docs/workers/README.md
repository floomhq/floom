# Workers Smoke Matrix

The stock-worker inventory lives in `docs/workers/MANIFEST.md`.

The daily smoke runner is `scripts/prod_smoke_matrix.py`.

Run it with a live API and `FLOOM_SECRET`:

```bash
python scripts/prod_smoke_matrix.py \
  --api https://workers-api.floom.dev \
  --secret "$FLOOM_SECRET"
```

By default it writes a dated report to:

`docs/workers/SMOKE-RESULTS-YYYY-MM-DD.md`

The report includes:

- the active stock-worker smoke matrix,
- the system metrics snapshot used for the run-failure-rate audit,
- open alert incidents,
- the top 7-day failure streams.

The `opendraft` row uses a start-and-cancel smoke instead of waiting for the full authoring run.
