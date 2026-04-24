# Contributing to Floom

Thanks for taking the time. Floom is small, moves fast, and every contribution gets read.

## Ways to help

- **File an issue.** Bug reports, feature requests, and design feedback all go to [GitHub issues](https://github.com/floomhq/floom/issues).
- **Add an example or showcase app.** Drop a manifest under [`examples/`](./examples) and open a PR. See [Adding a showcase app](#adding-a-showcase-app) below for the full recipe.
- **Fix a bug or ship a small feature.** Look for issues tagged `good first issue` or `help wanted`.
- **Improve docs.** Anything under [`docs/`](./docs) and [`spec/`](./spec) is fair game.

## Public repo boundary

- `floomhq/floom` is the public OSS repo.
- Product code, examples, specs, public docs, and redacted sample config belong here.
- Internal strategy, GTM plans, interview notes, private app backlogs, stash archives, local asset inventories, and ops notes do not belong in this repo.
- Do not add `docs/internal/` to this repo.

## Local setup

```bash
git clone https://github.com/floomhq/floom.git
cd floom
pnpm install
pnpm dev
```

- Web runs on `http://localhost:5173`
- Server runs on `http://localhost:3051`

Node `>=20`, pnpm `>=9`, Docker (for hosted-mode apps).

## Before you open a PR

1. Run `pnpm -r typecheck` and make sure it is clean.
2. Run `pnpm --filter @floom/server test` if you touched the server.
3. Keep the diff small. One concern per PR.
4. Link the issue it closes (`Closes #123`).

## Adding a showcase app

Want your app to show up in the README's Showcase section? Great. The bar is:

1. It does something real — not a toy endpoint.
2. The manifest lives under `examples/<slug>/` with a `floom.yaml` + `README.md`.
3. It runs in a self-hosted Docker image without pulling from a private registry.
4. Inputs + outputs have proper OpenAPI schemas with descriptions (so the web form renders nicely).

Steps:

```bash
mkdir examples/my-app
cd examples/my-app
# drop your floom.yaml, Dockerfile, main.py / server.ts, README.md
```

Look at [`examples/lead-scorer/`](./examples/lead-scorer), [`examples/competitor-analyzer/`](./examples/competitor-analyzer), and [`examples/resume-screener/`](./examples/resume-screener) for the pattern. Each one declares its `floom.yaml` + a minimal Dockerfile + an OpenAPI-documented handler.

Open a PR and describe what the app does in a single sentence. If it's genuinely interesting, it goes in the README.

## Test matrix

- `pnpm -r typecheck` — required on every PR.
- `pnpm --filter @floom/server test` — required if you touched `apps/server` or any of the `packages/*`.
- `pnpm --filter @floom/web build` — required if you touched `apps/web`.

CI runs the full matrix on every push. See [`.github/workflows/ci.yml`](./.github/workflows/ci.yml) for the exact commands.

## Code style

- TypeScript. Prefer `type` over `interface` for props, `interface` for public contracts.
- 2-space indent, single quotes, no semicolons optional (Prettier config wins).
- No inline styles in new components — use CSS modules or the shared CSS vars in `apps/web/src/styles/`.
- Log with `console.log('[subsystem] …')` — the prefix makes `docker logs` greppable.
- Comments explain **why**, not what. Dates and issue numbers (`// 2026-04-22 (#348)`) are encouraged.

## Commit style

Conventional-ish but pragmatic. Examples from the repo history:

```
feat(mcp): add ingest_app, list_apps, search_apps, get_app
fix(deps): bump tsx 4.19.2 -> 4.21.0 to drop esbuild 0.23 transitive
docs(self-host): correct monorepo image path
```

## Questions

See [SUPPORT.md](./SUPPORT.md) for the current support paths. Use GitHub issues for public bugs, docs gaps, and feature requests; use `team@floom.dev` for private matters.

By contributing you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md) and that your work is licensed under the MIT license.
