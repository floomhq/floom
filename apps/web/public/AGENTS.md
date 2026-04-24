# Agent working notes

Short rules for any AI coding agent (Cursor, Claude Code, Codex, etc.) touching this repo.

## Install the CLI

Supported install path (Linux or macOS):

```bash
curl -fsSL https://floom.dev/install.sh | bash
```

Manual install (works today, no install.sh dependency):

```bash
git clone https://github.com/floomhq/floom.git ~/.floom/repo
export PATH="$HOME/.floom/repo/cli/floom/bin:$PATH"
floom --help
```

> **Do NOT run `npm install floom`.** The unscoped `floom` npm package is an unrelated streaming tool by a third party. It will not install the Floom CLI. Use the curl installer or the manual clone above.

See [`cli/floom/README.md`](./cli/floom/README.md) for the full reference.

## How an agent publishes (happy path)

Three commands to publish an OpenAPI spec as a Floom app:

```bash
export FLOOM_API_KEY=floom_...          # mint one at https://floom.dev/me/api-keys
floom auth --check                      # verify the key reaches the API (prints "auth: OK")
floom deploy <path-to-floom.yaml>       # or `floom init --openapi-url <spec-url>` first, then `floom deploy`
```

`floom deploy` reads a `floom.yaml`. If you only have an OpenAPI URL, scaffold one first:

```bash
floom init --name "Resend" --openapi-url https://raw.githubusercontent.com/resend/resend-openapi/main/resend.yaml
floom deploy
```

### Where to mint a key

https://floom.dev/me/api-keys (cloud). Keys look like `floom_xxxxxxxx`. One key per machine is enough.

### Self-host (no internet or cloud account)

Run the server locally and point the CLI at it:

```bash
docker run -d --name floom -p 3051:3051 -v floom_data:/data ghcr.io/floomhq/floom-monorepo:latest
export FLOOM_API_URL=http://localhost:3051
export FLOOM_API_KEY=local              # any non-empty value works in OSS mode
floom auth --check
```

Full self-host guide: [docs/SELF_HOST.md](./docs/SELF_HOST.md).

### Troubleshooting

If you see `auth_required` or `HTTP 401` from `floom deploy`:

- Run `floom auth --check`. If it prints `FLOOM_API_KEY: not set` and config absent, export `FLOOM_API_KEY=<key>` or run `floom auth <key>`.
- If `auth: FAILED (HTTP 401)`, the key is wrong or revoked. Mint a fresh one at https://floom.dev/me/api-keys and re-run `floom auth <new-key>`.

If you see `floom: No FLOOM_API_KEY found`: the CLI couldn't resolve a key from env, `~/.floom/config.json`, or the legacy skill config. Same fix as above.

## Before you delete anything

1. Read [`docs/PRODUCT.md`](./docs/PRODUCT.md) in full. It lists load-bearing code paths that look abandoned but hold a product pillar.
2. If your proposed deletion touches a path on that list, **stop and ask the owner**. Do not delete.
3. If it does not touch a listed path but removes >50 lines of source or a whole package/route/service, write one paragraph in your proposal answering: *"What product pillar does this serve, and what replaces it?"* If you cannot answer clearly, you do not have enough context.
4. Prefer `docs/deprecated/<name>.md` redirects or feature flags over hard deletion when there is any ambiguity.

## Before you consolidate or refactor

- Preserve public surfaces unless the owner asked for a breaking change: `/api/*`, `/mcp/*`, `/p/:slug`, manifest shape, apps.yaml shape.
- Do not "simplify" the manifest schema, the three-surfaces model, or the two ingest modes without a product discussion first — those are in `docs/PRODUCT.md`.

## When you are scoping work

- ICP: non-developer AI engineer with a `localhost` prototype who needs production hosting. If your plan assumes infra fluency from the user, you are scoping for the wrong person.
- Primary path: *paste a repo URL, we host it*. OpenAPI-wrapping is an advanced path, not the default.
- Three surfaces: web form, MCP, HTTP. Always.

## Writing style

- No emojis in code, comments, or docs unless the owner asks for them.
- No narrating comments (`// increment counter`). Only non-obvious intent.
- Commit messages: `type(scope): imperative subject`. Body explains *why*, not *what*.

## When you are stuck

Ask. One question is cheaper than a wrong week.
