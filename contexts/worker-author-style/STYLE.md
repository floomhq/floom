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

## Worker memory

Worker memory is enabled by default. The runtime mounts it as a writeable local
context, usually `context/memory-<worker-id>/` unless worker.yml sets
`memory.context`, with `MEMORY.md` created on first use.

- Generated workers must read `context/<memory-context>/MEMORY.md` or the
  memory folder at the start of each run and treat a missing file as empty.
- Generated workers must write new durable learnings, user preferences,
  corrections, checkpoints, or reusable state back to the memory folder before
  finishing only when the run discovers something worth preserving. Leave memory
  unchanged when there is no durable update.
- Keep memory concise and durable. Do not store one-off outputs, large raw
  payloads, transient logs, duplicate notes, or secrets.

## Input field conventions

- `name`: snake_case identifier
- `label`: Title Case, short (2-4 words), shown above the field in the UI
- `placeholder`: concrete example value in italics, starts with "e.g."
- `required: true` only for inputs without a sensible default
- Prefer `type: "textarea"` for multi-line text, `type: "string"` for single-line

## Output field conventions

- `name`: snake_case, matches what the SKILL.md or run.py writes
- Include at least one operator-facing output that reads well in the Output tab.
  Use names such as `summary`, `digest`, `report`, `notification`, or `result`
  for the thing the operator actually asked to receive.
- Use `kind: "scalar"` with `type: "markdown"`, `type: "textarea"`, `type: "string"`,
  or `type: "number"` when the output is a short readable result that can be
  returned inline. The worker writes the literal value into `result.json`.
- Use `kind: "file"` only for downloadable artifacts: CSV exports, JSON data,
  PDFs, attachments, or long markdown documents. File outputs need
  `media_type` and `path` under `out/` (e.g., `out/digest.md`, `out/result.json`).
- Gmail/email/CRM/digest workers need a readable markdown/text output first,
  with any raw JSON or CSV export listed as a secondary file.
- `label`: 2-4 words, Title Case

## Version

- Always `0.1.0` for new workers
- Bump patch for bug fixes, minor for feature additions, major for breaking input/output changes

## Targets

- Always `["generic"]` unless you have a specific reason for another target
