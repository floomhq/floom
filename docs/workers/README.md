# Workers Smoke Matrix

The stock-worker inventory lives in `docs/workers/MANIFEST.md`.

The daily smoke runner is `scripts/prod_smoke_matrix.py`.

Run it with a live API and `FLOOM_SECRET`:

```bash
python scripts/prod_smoke_matrix.py \
  --api https://workers-api.floom.dev \
  --secret "$FLOOM_SECRET"
```

Run a subset during investigation:

```bash
python scripts/prod_smoke_matrix.py \
  --api https://workers-api.floom.dev \
  --secret "$FLOOM_SECRET" \
  --workers research_brief,weekly_update
```

By default it writes a dated report to:

`docs/workers/SMOKE-RESULTS-YYYY-MM-DD.md`

The report includes:

- the active stock-worker smoke matrix,
- the system metrics snapshot used for the run-failure-rate audit,
- open alert incidents,
- the top 7-day failure streams.

The `opendraft` row uses a start-and-cancel smoke instead of waiting for the full authoring run.

## self-hosted server Cron

The tracked cron wrapper is `scripts/workeros-prod-smoke-cron.sh`. It reads
`FLOOM_SECRET` from the environment or `${WORKEROS_REPO_DIR}/.deploy-secret`,
runs the API matrix, writes `/var/log/workeros-smoke/api-smoke-*.log`, and exits
non-zero when any active worker fails.

Install on self-hosted server root crontab:

```cron
15 6 * * 1 WORKEROS_REPO_DIR=/root/workeros /root/workeros/scripts/workeros-prod-smoke-cron.sh
```

Keep this API matrix separate from the OpenBrowser UI sweep cron. The UI sweep
proves browser paths; this API matrix proves active stock workers with fixture
inputs and creates the dated `SMOKE-RESULTS-YYYY-MM-DD.md` report.
