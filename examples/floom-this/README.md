# Floom This

Day 7 deterministic Floom intake app. It accepts a public GitHub repo URL plus optional workflow context and returns a zero-token app intake card with a floomability score, suggested slug, required inputs, suggested outputs, build plan, next step, and share card.

## Run

```bash
PORT=4117 node examples/floom-this/server.mjs
```

## Register

Point the Floom server at the app manifest:

```bash
FLOOM_APPS_CONFIG=examples/floom-this/apps.yaml
```

The manifest registers one proxied app:

- slug: `floom-this`
- OpenAPI: `http://localhost:4117/floom-this/openapi.json`
- analyze endpoint: `POST http://localhost:4117/floom-this/analyze`
- health endpoint: `GET http://localhost:4117/health`

## Request

```json
{
  "repo_url": "https://github.com/example/acme",
  "script_description": "Score inbound lead CSV rows and return a prioritized follow-up list for sales.",
  "input_type": "csv",
  "desired_output": "prioritized lead list",
  "contact": "ops@example.com"
}
```

`repo_url` is required. `script_description`, `input_type`, `desired_output`, and `contact` are optional context.

## Response

```json
{
  "floomability_score": 86,
  "suggested_app_slug": "score-inbound-lead-csv",
  "required_inputs": ["repo_url", "csv_input", "contact"],
  "suggested_outputs": ["prioritized lead list", "execution_summary", "next_action"],
  "build_plan": [
    "Define the score-inbound-lead-csv request schema around csv input and script_description.",
    "Inspect the repository entrypoint and map the current script behavior to a proxied endpoint.",
    "Implement deterministic validation, normalization, and result formatting.",
    "Return prioritized lead list, execution_summary, next_action plus a compact share card for handoff.",
    "Add OpenAPI metadata and smoke tests for success, validation, and health routes."
  ],
  "next_step": "Build score-inbound-lead-csv as a proxied Floom app with the listed inputs and outputs.",
  "share_card": "Floom This: score-inbound-lead-csv\nScore: 86/100\nInput: csv\nOutputs: prioritized lead list, execution_summary, next_action\nContact: ops@example.com"
}
```

## Validation

Missing or blank `repo_url` returns HTTP 400:

```json
{
  "error": "missing required field 'repo_url'"
}
```
