# Getting started

Five minutes from never-heard-of-Floom to a live, shareable app.

Floom turns an **OpenAPI spec** (the standard way APIs describe themselves) into three things at once: a web form your teammates can fill in, an MCP tool your agent can call, and an HTTP endpoint your code can hit. One manifest, three surfaces.

## What you need

- A browser.
- An OpenAPI spec URL (any REST API with a published spec — Stripe, Resend, OpenAI, GitHub, your own). Floom ships a public directory of 100+ pre-wired apps if you just want to try one.
- A Floom account on [floom.dev](https://floom.dev) (free during beta).

That's it. No CLI install. No Docker on your laptop. No YAML to hand-write.

## Step 1. Browse or build

Go to [floom.dev](https://floom.dev) and either:

- **Browse** — pick something from the app store at [floom.dev/apps](https://floom.dev/apps). You get an instant form to run it from.
- **Build** — head to [floom.dev/studio/build](https://floom.dev/studio/build) and paste an OpenAPI spec URL. Floom reads it, generates a form per operation, and gives you a permalink.

### Paste-an-OpenAPI example

```
https://raw.githubusercontent.com/resend/resend-openapi/main/resend.yaml
```

Paste that URL into the build form and hit **Detect**. Floom scans the spec, shows you the operations it found (send email, list audiences, etc.), and lets you publish in one click.

## Step 2. Add your secret

If the app calls an API that needs a key (most do), Floom asks for it once, stores it encrypted per-user, and injects it at run time. You never paste keys into forms, URLs, or the front-end.

Go to your app's **Secrets** tab inside [floom.dev/studio](https://floom.dev/studio) and paste your key. Floom's vault holds it; no one else sees it.

## Step 3. Run it

Three ways to run the same app:

### From the browser

Every app has a permalink at `floom.dev/p/<slug>`. Open it, fill the form, hit **Run**. The output renders inline. Share the result URL — it's a read-only snapshot anyone can open.

### From an agent (MCP)

Each app exposes an **MCP server** — the protocol Claude, Cursor, and other agents speak natively. Point your agent at:

```
https://floom.dev/mcp/app/<slug>
```

Your agent now has the app's operations as callable tools, with inputs and outputs typed the way the OpenAPI spec described them. No glue code.

Want to install it in Claude Desktop? Each app has an **Install** button that generates the right config snippet. See [Claude Desktop setup](https://github.com/floomhq/floom/blob/main/docs/CLAUDE_DESKTOP_SETUP.md).

### From code (HTTP)

```bash
curl -X POST https://floom.dev/api/<slug>/run \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <your-floom-api-key>" \
  -d '{"action": "send", "inputs": {"to": "you@example.com", "subject": "hi"}}'
```

You get back `{ "run_id": "...", "status": "pending" }`. Poll `GET /api/run/<run_id>` or stream logs over Server-Sent Events at `GET /api/run/<run_id>/stream`.

## Step 4. Share

Every run has a public permalink at `floom.dev/r/<run_id>`. Paste it in Slack, a PR comment, a tweet. The reader sees the same inputs and outputs the runner saw, no login needed (for public apps).

Public apps show up in [floom.dev/apps](https://floom.dev/apps). Private apps don't.

## What about hosted-mode apps?

The examples above are **proxied** apps — Floom wraps an existing API you already trust. Floom also supports **hosted** apps — you write a Python or Node script, declare it in a `floom.yaml`, and Floom runs it inside a sandbox with your secrets injected. This is how the launch-day demos ([lead-scorer](https://github.com/floomhq/floom/tree/main/examples/lead-scorer), [competitor-analyzer](https://github.com/floomhq/floom/tree/main/examples/competitor-analyzer), [resume-screener](https://github.com/floomhq/floom/tree/main/examples/resume-screener)) work.

Hosted mode gets its own write-up on the [Protocol](./protocol) page.

## Next

- [Protocol](./protocol) — the full shape of a Floom manifest and what each surface does.
- [Deploy](./deploy) — run Floom yourself (self-host) or pick the hosted tier.
- [Limits](./limits) — the hard numbers (runtime, memory, rate limits, file sizes) before you build on top of us.
