# Examples

Real apps shipping on Floom today. Each one is a single manifest plus code — clone, read, or run.

Pick the shape closest to what you're building, copy its `floom.yaml`, swap the logic.

## Lead scorer

Score a company against an ICP description. JSON in, scored breakdown out.

- **Shape**: single action, LLM-backed, cached.
- **Use for**: sales-ops scoring, account prioritisation, inbound triage.
- **Run it**: [`/p/lead-scorer`](/p/lead-scorer)
- **Source**: [`examples/lead-scorer/`](https://github.com/floomhq/floom/tree/main/examples/lead-scorer)

```bash
curl -X POST https://floom.dev/api/lead-scorer/run \
  -H "Content-Type: application/json" \
  -d '{"action":"score","inputs":{"company":"stripe.com","icp":"B2B SaaS, series A+"}}'
```

## Competitor analyzer

Given a domain, pull positioning, pricing, and differentiators. Single tool call per competitor.

- **Shape**: sequenced web lookups, markdown report out.
- **Use for**: sales battlecards, GTM research, positioning audits.
- **Run it**: [`/p/competitor-analyzer`](/p/competitor-analyzer)
- **Source**: [`examples/competitor-analyzer/`](https://github.com/floomhq/floom/tree/main/examples/competitor-analyzer)

```bash
curl -X POST https://floom.dev/api/competitor-analyzer/run \
  -H "Content-Type: application/json" \
  -d '{"action":"analyze","inputs":{"domain":"linear.app"}}'
```

## Resume screener

Score a CV against a job description. Returns strengths, gaps, fit score.

- **Shape**: file-input app (PDF upload), JSON scored output.
- **Use for**: recruiter triage, candidate ranking, rejection letters.
- **Run it**: [`/p/resume-screener`](/p/resume-screener)
- **Source**: [`examples/resume-screener/`](https://github.com/floomhq/floom/tree/main/examples/resume-screener)

```bash
curl -X POST https://floom.dev/api/resume-screener/run \
  -H "Content-Type: application/json" \
  -d '{"action":"screen","inputs":{"jd":"Senior Backend Engineer","cv_url":"..."}}'
```

## More examples

The `examples/` directory in the repo has more shapes to copy from:

- **JWT decode** — zero-auth utility app (no API key needed).
- **UUID generator** — simplest possible manifest, one action, no inputs.
- **JSON format** — fast utility, showcases `renderer: json`.
- **Password generator** — minimal manifest, anon-runnable.

See [github.com/floomhq/floom/tree/main/examples](https://github.com/floomhq/floom/tree/main/examples) for the full list.

## Next

- [Quickstart](/docs/quickstart) — write your own from scratch in 5 minutes.
- [Manifest reference](/docs/runtime-specs) — every field explained.
- [Install in Claude](/docs/mcp-install) — use these examples from your agent.
