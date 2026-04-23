# Resume Screener

Upload a zip of candidate CVs (PDFs) and a job description, get back a ranked shortlist with reasoning, gaps, and must-have pass/fail per candidate.

Third Floom demo app (alongside [lead-scorer](../lead-scorer) and the forthcoming competitor analyzer). Lives at `/root/floom/examples/resume-screener/`.

## What it does

1. Unpacks the uploaded zip, finds every `.pdf` at the top level.
2. Extracts text from each PDF in parallel (ThreadPoolExecutor, 8 workers) using `pypdf`.
3. For every CV, asks Gemini 3 (`gemini-3.1-pro-preview`) to score it 0-100 against the JD, cite concrete evidence, list gaps, and mark `must_have_pass`.
4. Sorts by `must_have_pass` (passes first), then score desc.
5. Bad PDFs are flagged `pdf_parse_failed` and kept in the output; they do not crash the run.
6. Candidate names and contact info are redacted from stdout logs (each CV gets a short `cv-<hash>` id).

No web search, no URL context. Everything is in the CVs.

## Inputs

| name              | type     | required | notes |
|-------------------|----------|----------|-------|
| `cvs_zip`         | file     | yes      | A `.zip` containing one or more PDFs. See schema note below. |
| `job_description` | textarea | yes      | Free-text JD. |
| `must_haves`      | textarea | no       | Optional hard requirements, one per line. Any miss → `must_have_pass: false`. |

### Schema note: why a zip, not an array of files?

The Floom v2.0 manifest (`apps/server/src/services/manifest.ts`) currently accepts these input types: `text, textarea, url, number, enum, boolean, date, file`. No `array` type, no nested `items: {type: file/pdf}`. So instead of the spec's original `cvs: array of file/pdf`, we take a single zip and unpack it in the sandbox. Swap to a true multi-file input once the manifest grows a `file[]` / `array-of-file` shape (see `packages/renderer/src/contract/index.ts` input-shape discriminator, which already recognises `type: array, items.format: binary → multifile`).

## Outputs

`ranked` — list of per-candidate results, sorted best-first:

```json
{
  "#": 1,
  "filename": "01-alice-backend.pdf",
  "redacted_id": "cv-f24fdfd2",
  "status": "ok",
  "score": 98,
  "reasoning": "8 years of backend at Plaid and Stripe, FastAPI + Postgres + AWS, Kafka event sourcing...",
  "match_summary": "Exceptional Python/Postgres candidate with FastAPI and Kafka.",
  "gaps": [],
  "must_have_pass": true
}
```

Plus:

- `summary` — one-line natural-language recap.
- `model` — `gemini-3.1-pro-preview` (or `dry-run`).
- `total / scored / failed / dry_run` — counters.

## Secrets

- `GEMINI_API_KEY` — the Gemini 3 key. If unset, the app falls back to a deterministic dry-run scorer (keyword overlap + hashed noise) so the demo runs end-to-end without a live key.

## Run it

### Local (no Docker)

```bash
cd /root/floom/examples/resume-screener
pip install -r requirements.txt

# 1. Package the CVs
cd sample-cvs && zip -q cvs.zip *.pdf && cd ..

# 2. Run (dry-run, no key)
python3 main.py '{
  "action": "screen",
  "inputs": {
    "cvs_zip": "sample-cvs/cvs.zip",
    "job_description": "Senior Backend Engineer. Python, FastAPI, PostgreSQL, AWS. 5+ years.",
    "must_haves": "Python\nPostgreSQL"
  }
}'

# 3. Run live against Gemini 3
GEMINI_API_KEY=your-key python3 main.py '...'
```

### Docker

```bash
docker build -t resume-screener:latest .
docker run --rm \
  -e GEMINI_API_KEY=your-key \
  -v "$PWD/sample-cvs:/floom/inputs:ro" \
  resume-screener:latest '{
    "action": "screen",
    "inputs": {
      "cvs_zip": "/floom/inputs/cvs.zip",
      "job_description": "Senior Backend Engineer. Python, FastAPI, PostgreSQL, AWS. 5+ years. Bonus: Kafka.",
      "must_haves": "Python\nPostgreSQL"
    }
  }'
```

Image size: ~175 MB (python:3.12-slim + pypdf + google-genai).

## Example

### Job description

> Senior Backend Engineer (Python). You will own a high-throughput service in Python + FastAPI on AWS, with PostgreSQL as the primary store. 5+ years of backend experience required. Strong SQL, distributed systems, production on-call. Bonus: Kafka, event sourcing.

### Must-haves

```
Python
PostgreSQL
5+ years backend
```

### Fixture CVs (sample-cvs/)

1. **Alice Johnson** — Senior Backend Engineer, 8y Python + Postgres + FastAPI at Plaid and Stripe, Kafka event sourcing, on-call. San Francisco.
2. **Bob Martinez** — Full-stack, 5y, mostly Node.js + React, MongoDB-heavy, Python only for data scripts. Seattle.
3. **Dirk Weber** — Senior Backend Engineer, 7y Python + Postgres + FastAPI at N26 and Solaris (Berlin fintechs), Kafka + Debezium, on-call. Berlin.

The set intentionally spans two locations (SF + Berlin) with a top-fit
candidate in each, so the demo surfaces a strong match whether or not
the JD adds a location / timezone must-have.

### Actual live output (Gemini 3)

| # | Candidate | Score | must_have_pass | Why |
|---|-----------|-------|----------------|-----|
| 1 | cv-f24fdfd2 (Alice) | **98** | true  | 8y backend, direct FastAPI + Postgres + AWS + Kafka match. |
| 2 | cv-aa6f12c9 (Dirk)  | **92** | true  | 7y Python + Postgres + FastAPI + AWS + Kafka at Berlin fintechs. |
| 3 | cv-7747237b (Bob)   |  30   | false | Node.js/MongoDB core, Python only for ETL. |

`summary`: "Screened 3 CV(s) against the JD. 3 scored, 0 failed. Top candidate: cv-f24fdfd2 (98/100)."

## Failure modes

| Situation                      | Behaviour                                                   |
|--------------------------------|-------------------------------------------------------------|
| PDF is image-only / encrypted  | Candidate row: `status: "error", error: "pdf_parse_failed"` |
| Gemini rate limit              | Retry once, then record `scoring_failed` for that candidate |
| `GEMINI_API_KEY` missing       | Dry-run mode: keyword-overlap mock score                    |
| Archive has 0 PDFs             | Returns `total: 0` and an explanatory summary               |
| Whole container OOMs           | Floom entrypoint surfaces `error_type: "oom"`               |

One failed CV never aborts the other screenings.

## Files

- `main.py` — the app (exports `screen(...)` for Floom entrypoint + `_cli()` for standalone Docker).
- `floom.yaml` — manifest v2.0.
- `Dockerfile` — standalone image. Floom's managed build path generates its own Dockerfile (see `apps/server/src/services/docker.ts`); this one is for direct `docker run`.
- `requirements.txt` — `pypdf`, `google-genai`.
- `sample-cvs/` — three fake CVs + a pre-packaged `cvs.zip`.
