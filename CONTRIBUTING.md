# Contributing to Floom

Thanks for taking the time. Floom is small, moves fast, and every contribution gets read.

## Ways to help

- **File an issue.** Bug reports, feature requests, and design feedback all go to [GitHub issues](https://github.com/floomhq/floom/issues).
- **Add an example app.** Drop a manifest under [`examples/`](./examples) and open a PR.
- **Fix a bug or ship a small feature.** Look for issues tagged `good first issue` or `help wanted`.
- **Improve docs.** Anything under [`docs/`](./docs) and [`spec/`](./spec) is fair game.

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

## Commit style

Conventional-ish but pragmatic. Examples from the repo history:

```
feat(mcp): add ingest_app, list_apps, search_apps, get_app
fix(deps): bump tsx 4.19.2 -> 4.21.0 to drop esbuild 0.23 transitive
docs(self-host): correct monorepo image path
```

## Questions

Open a GitHub discussion or email team@floom.dev.

By contributing you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md) and that your work is licensed under the MIT license.
