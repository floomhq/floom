# Worker Author Style Guide

## Naming conventions

### Worker IDs (`name` field)

- Format: `lowercase-with-hyphens`
- Length: 3-64 characters; start and end with alphanumeric
- Be specific: `github-pr-digest` not `digest`, `gmail-invoice-to-sheets` not `invoice`
- Use domain prefix for integrations: `github-`, `gmail-`, `slack-`, `hubspot-`
- Use action suffix for automation: `-digest`, `-sync`, `-notify`, `-enrich`, `-report`

Good: `github-pr-digest`, `gmail-invoice-to-sheets`, `hubspot-deal-slack-notify`
Bad: `my-worker`, `test`, `automation`, `new-worker`

### Titles

- Title case: `GitHub PR Digest`, `Gmail Invoice to Sheets`
- 5-60 characters
- No articles: `Research Brief` not `A Research Brief Generator`

### Descriptions

- One sentence, 20-120 chars
- Start with a verb (active voice): `Sends`, `Generates`, `Pulls`, `Syncs`, `Extracts`
- No jargon: write for a non-technical operator
- No trailing period required

Good: `Sends a daily digest of open GitHub PRs to Slack`
Bad: `This worker will generate and send digest emails for github pull requests`

## Tag taxonomy

Use existing tags where possible:

| Category | Tags |
|----------|------|
| Output format | `markdown`, `csv`, `json`, `pdf` |
| Frequency | `daily`, `weekly`, `on-demand` |
| Domain | `github`, `gmail`, `slack`, `hubspot`, `notion`, `sheets` |
| Function | `digest`, `sync`, `notify`, `report`, `enrich`, `search` |
| Audience | `sales`, `engineering`, `operations`, `marketing` |

## Folder taxonomy

Use existing folders where possible:

- `Operations/Reporting` — status updates, digests, weekly briefs
- `Sales/CRM` — HubSpot, Salesforce, deal tracking
- `Engineering/GitHub` — PRs, issues, code review
- `Content/Blog` — articles, SEO, blog posts
- `HR/Recruiting` — CV screening, job matching, outreach
- `Finance/Invoicing` — invoice processing, payments
- `Data/Enrichment` — CSV enrichment, data transforms

## Input field conventions

- `name`: snake_case identifier
- `label`: Title Case, short (2-4 words), shown above the field in the UI
- `placeholder`: concrete example value in italics, starts with "e.g."
- `required: true` only for inputs without a sensible default
- Prefer `type: "textarea"` for multi-line text, `type: "string"` for single-line

## Output field conventions

- `name`: snake_case, matches what the SKILL.md or run.py writes
- `kind: "file"` for everything (workers write files, not inline strings)
- `media_type`: be precise — `text/markdown` renders inline, `application/json` shows raw
- `path`: always under `out/` (e.g., `out/digest.md`, `out/result.json`)
- `label`: 2-4 words, Title Case

## Version

- Always `0.1.0` for new workers
- Bump patch for bug fixes, minor for feature additions, major for breaking input/output changes

## Targets

- Always `["generic"]` unless you have a specific reason for another target
