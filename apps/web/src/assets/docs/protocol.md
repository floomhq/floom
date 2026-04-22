# Protocol

Floom turns a single source of truth — an **OpenAPI spec** — into every surface an agent or human can use: a web form, an MCP server (the protocol agents speak), and an HTTP API. One spec, every surface.

This page covers the minimum you need to publish an app. The full wire-level contract (job queue, error codes, signed webhooks, renderer hints) lives at [`/protocol`](/protocol) and [`spec/protocol.md`](https://github.com/floomhq/floom/blob/main/spec/protocol.md).

## Two kinds of Floom app

### 1. Proxied — wrap an existing API

Point Floom at an OpenAPI spec URL. Floom reads it, turns every operation into a form + MCP tool + HTTP endpoint, and proxies calls to the real API — injecting your secret at runtime so your key never leaves Floom.

```yaml
# floom.yaml (proxied)
name: resend
type: proxied
openapi_spec_url: https://raw.githubusercontent.com/resend/resend-openapi/main/resend.yaml
base_url: https://api.resend.com
auth: bearer
secrets: [RESEND_API_KEY]
```

Use this when the work you want to expose is already an API somewhere.

### 2. Hosted — Floom runs your code

Write a Python or Node script. Declare inputs and outputs in `floom.yaml`. Floom builds a sandboxed container, injects your secrets, and runs the script for every call. The output is rendered as a table, JSON, text, markdown, or a custom React component.

```yaml
# floom.yaml (hosted)
name: Lead Scorer
slug: lead-scorer
description: Score a CSV of leads against an ICP with Gemini 3.
category: growth
manifest_version: "2.0"
runtime: python
python_dependencies:
  - google-genai==1.64.0
secrets_needed:
  - GEMINI_API_KEY
actions:
  score:
    label: Score Leads
    inputs:
      - name: data
        label: Leads CSV
        type: file/csv
        required: true
      - name: icp
        label: Ideal Customer Profile
        type: textarea
        required: true
    outputs:
      - name: rows
        label: Scored Leads
        type: table
      - name: score_distribution
        type: json
```

Use this when you're building something new — an AI-powered scoring tool, a scraper, a document processor.

## The Python harness (hosted mode)

Your script receives the run config on `argv[1]` as JSON, does its work, and prints one line starting with `__FLOOM_RESULT__` before exiting. That's the whole protocol.

```python
# main.py
import json, sys

def score(data, icp, **_):
    # your logic here
    return {"rows": [...], "score_distribution": {...}}

if __name__ == "__main__":
    config = json.loads(sys.argv[1])
    inputs = config.get("inputs") or {}
    try:
        outputs = score(**inputs)
        sys.stdout.write("__FLOOM_RESULT__" + json.dumps({"ok": True, "outputs": outputs}) + "\n")
    except Exception as exc:
        sys.stdout.write("__FLOOM_RESULT__" + json.dumps({"ok": False, "error": str(exc)}) + "\n")
```

File inputs (`type: file/csv`, `type: file`) arrive mounted read-only at `/floom/inputs/<name>.<ext>`. Your script reads them with `open(path)`. Max file size: 6 MB per upload.

Full runnable example with real AI calls: [examples/lead-scorer/main.py](https://github.com/floomhq/floom/blob/main/examples/lead-scorer/main.py).

## What Floom gives you (every app, every surface)

- **Input validation** — bad types, missing required fields, wrong-length strings are rejected at the edge with a clear error. Your code never sees garbage.
- **Secrets injection** — declare `secrets_needed` in the manifest. Floom stores values encrypted per-user, reads them from a vault at run time, and injects them as environment variables. No keys in forms, URLs, or logs.
- **Rate limiting** — per-IP, per-user, and per-app buckets applied automatically. See [Limits](./limits) for the numbers.
- **Output rendering** — tables render as sortable tables, JSON as collapsible trees, markdown as formatted text, files as downloads. Override with a custom React bundle if you want.
- **Run history** — every call is stored. You can share a result URL (`floom.dev/r/<run_id>`) with anyone and they see the exact inputs and outputs.
- **MCP server** — zero extra work. Every app exposes an MCP server at `/mcp/app/<slug>` with one tool per action.
- **HTTP API** — every app exposes `POST /api/<slug>/run`, with logs you can stream over Server-Sent Events.

## Coming in the next few weeks

These are part of the protocol and locked into the roadmap. Not shipped yet.

- **Job queue** — long-running runs up to 30 minutes, with webhook delivery on completion, retries, and cancellation. Partly shipped; full release in v0.5.
- **Streaming output** — tokens stream to the UI as the script prints them, for LLM-style progressive reveal.
- **Session state** — resumable multi-turn runs that remember earlier inputs and outputs.
- **Custom input renderers** — like the existing custom output renderer, but for the form side.
- **Larger file uploads** — multi-MB uploads today, arbitrary sizes on the roadmap.

## Next

- [Getting started](./getting-started) — deploy your first app in 5 minutes.
- [Deploy](./deploy) — self-host, cloud, or hybrid.
- [Limits](./limits) — hard numbers for runtime, memory, and rate limits.
- [Full spec](https://github.com/floomhq/floom/blob/main/spec/protocol.md) — wire-level details for anyone building an alternate server.
