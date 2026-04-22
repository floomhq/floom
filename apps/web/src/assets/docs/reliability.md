# Reliability and SLA

Floom does **not** publish a formal uptime SLA in this repo today. The current launch-week stance is explicit: best effort, monitored, and rollback-ready.

## What exists now

- Health checks at `GET /api/health`.
- Optional Prometheus metrics at `GET /api/metrics`.
- Optional Sentry error tracking when configured.
- A documented rollback runbook with drill steps.
- Preview-first deploy policy before manual production promotion.

## What does not exist now

- No public uptime percentage promise.
- No public status page linked from the product.
- No paid SLA tier documented for launch week.

## If Floom is down

- Cloud-hosted apps on that instance are down with it.
- Operators can use the rollback runbook to move back to the last known-good image.
- Self-hosting remains the ownership and continuity path for teams that need tighter control.

## Honest launch-week promise

- Floom is treating reliability as an engineering discipline, not as marketing copy.
- The repo is explicit about health checks, metrics, manual production promotion, and rollback.
- The repo is equally explicit that a formal SLA is not part of the launch surface today.

## Related pages

- [/docs/observability](/docs/observability)
- [/docs/workflow](/docs/workflow)
- [/docs/ownership](/docs/ownership)
