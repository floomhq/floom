# Launch Scorecards

Proxied-mode examples for two launch-oriented Floom apps:

- `linkedin-roaster`: fetches a public LinkedIn profile URL, scores the profile,
  and returns sharper positioning, a headline rewrite, an About rewrite, and
  post ideas.
- `yc-pitch-deck-critic`: scores an uploaded early-stage deck outline or text
  export.

The server is pure Node.js. It has no package dependencies and no model calls.
LinkedIn URL fetching uses `APIFY_API_KEY`; pasted profile text remains available
as a fallback for local testing.

## Run standalone

```bash
node examples/launch-scorecards/server.mjs
```

Health check:

```bash
curl -s http://localhost:4120/health | jq
```

OpenAPI specs:

```bash
curl -s http://localhost:4120/linkedin-roaster/openapi.json | jq .info.title
curl -s http://localhost:4120/yc-pitch-deck-critic/openapi.json | jq .info.title
```

Score a LinkedIn profile:

```bash
curl -sX POST http://localhost:4120/linkedin-roaster/score \
  -H 'content-type: application/json' \
  -d '{
    "linkedin_url": "https://www.linkedin.com/in/federicodeponte/",
    "profile_text": "Founder building Floom. I help startup founders turn local scripts and AI prototypes into real apps people can use. Built tools for launch workflows, agent sessions, utility scripts, and GTM research. Shipping today.",
    "audience": "B2B founders",
    "goal": "publish internal AI workflows as real products"
  }' | jq
```

Score a pitch deck text export:

```bash
node -e '
const text = "Slide 1 ExampleCo helps B2B founders fix launch conversion. Slide 2 Problem: teams ship without proof. Slide 3 Insight: AI makes launch QA cheap. Slide 4 Product: a workflow scorecard. Slide 5 Traction: 12 pilots, 3 paying customers. Slide 6 Market: millions of startup launches. Slide 7 Team: founders built GTM tools. Slide 8 Raising $750k for product and distribution.";
console.log(JSON.stringify({
  company: "ExampleCo",
  stage: "pre-seed",
  deck_file: {
    __file: true,
    name: "deck.md",
    mime_type: "text/markdown",
    size: Buffer.byteLength(text),
    content_b64: Buffer.from(text).toString("base64")
  }
}));
' | curl -sX POST http://localhost:4120/yc-pitch-deck-critic/score \
  -H 'content-type: application/json' \
  -d @- | jq
```

## Run via Floom

```bash
node examples/launch-scorecards/server.mjs &
FLOOM_APPS_CONFIG=examples/launch-scorecards/apps.yaml \
  DATA_DIR=/tmp/floom-launch-scorecards \
  node apps/server/dist/index.js
```

The `apps.yaml` file exposes two proxied Floom apps:

- `linkedin-roaster` -> `http://localhost:4120/linkedin-roaster/openapi.json`
- `yc-pitch-deck-critic` -> `http://localhost:4120/yc-pitch-deck-critic/openapi.json`
