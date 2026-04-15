# Fast Apps

Seven deterministic utility apps bundled with the Floom server as a single
Node.js proxied-mode sidecar. Designed for live demos: every handler runs in
under one millisecond, every response is deterministic given the same input,
and none of them require external APIs or secrets.

## Apps

| Slug | Name | What it does |
|---|---|---|
| `uuid` | UUID Generator | Generate 1 to 100 UUID v4 or v7 strings. |
| `password` | Password Generator | Cryptographically secure password, rejection-sampled, configurable alphabet. |
| `hash` | Hash | md5, sha1, sha256, sha512 hex digest of UTF-8 text. |
| `base64` | Base64 | Encode text to base64 or decode back, with URL-safe variant. |
| `json-format` | JSON Formatter | Pretty print JSON with configurable indent and optional key sorting. |
| `jwt-decode` | JWT Decoder | Decode a JWT header and payload without verifying the signature. |
| `word-count` | Word Count | Count words, characters, lines, sentences, paragraphs, reading time. |

All apps are in the `developer-tools` category, except `word-count` which is
in `writing`.

## Running

The Floom server forks this sidecar automatically at boot unless
`FLOOM_FAST_APPS=false` is set. Manual start:

```bash
node examples/fast-apps/server.mjs
# FAST_APPS_PORT=4200 by default
```

Then point Floom at the apps.yaml file via `FLOOM_APPS_CONFIG`:

```bash
FLOOM_APPS_CONFIG=examples/fast-apps/apps.yaml \
  node apps/server/dist/index.js
```

## Example calls

```bash
# UUID v7 (sortable)
curl -s -X POST http://127.0.0.1:4200/uuid/run \
  -H 'content-type: application/json' \
  -d '{"version":"v7","count":3}'

# Secure password, 24 chars, with symbols
curl -s -X POST http://127.0.0.1:4200/password/run \
  -H 'content-type: application/json' \
  -d '{"length":24,"symbols":true}'

# SHA-256 of a string
curl -s -X POST http://127.0.0.1:4200/hash/run \
  -H 'content-type: application/json' \
  -d '{"text":"hello world","algorithm":"sha256"}'

# Decode a JWT (inspection only, no verification)
curl -s -X POST http://127.0.0.1:4200/jwt-decode/run \
  -H 'content-type: application/json' \
  -d '{"token":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmbG9vbSJ9.sig"}'
```

Every endpoint also has a matching OpenAPI 3.0 spec at
`http://127.0.0.1:4200/openapi/<slug>.json` that Floom ingests at boot.

## Latency

Measured with 100 warm-path requests from a Node fetch client inside the
container:

| App | p50 | p95 | p99 |
|---|---|---|---|
| uuid | ~0.6 ms | ~1.5 ms | ~3.1 ms |
| password | ~0.6 ms | ~1.1 ms | ~2.4 ms |
| hash | ~0.5 ms | ~0.7 ms | ~1.4 ms |
| base64 | ~0.5 ms | ~0.7 ms | ~2.1 ms |
| json-format | ~0.5 ms | ~0.7 ms | ~5.1 ms |
| jwt-decode | ~0.5 ms | ~0.6 ms | ~0.9 ms |
| word-count | ~0.5 ms | ~0.6 ms | ~2.8 ms |

The Floom proxied-runner adds a few milliseconds of overhead (inputs
validation, fetch, output parsing, DB write), keeping end-to-end run time
under 50 ms for every app.

## Design notes

- Pure Node.js, zero external dependencies. Uses `node:crypto`,
  `node:http`, and `node:buffer`.
- Every handler validates inputs and returns a `400` with `{error, code}`
  on bad input. Never throws an unhandled exception back to the caller.
- Request bodies are capped at 1 MB. Larger payloads are rejected.
- UUID v7 is implemented inline because `crypto.randomUUID()` only
  generates v4 in Node 20.
- Password alphabet is rejection-sampled against the next power of two
  that fits the alphabet size, so the distribution is uniform.
- JWT decoding reads the first two base64url segments and parses them as
  JSON. Signature is returned but never verified, and the response is
  explicitly marked `verified: false`.
