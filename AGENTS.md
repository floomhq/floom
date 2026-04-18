# Agent working notes

Short rules for any AI coding agent (Cursor, Claude Code, Codex, etc.) touching this repo.

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
