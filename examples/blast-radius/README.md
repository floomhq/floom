# Blast Radius — proxied-mode example

Clones a public git repo, computes a branch diff, and returns changed files
plus a crude "affected files" set (files whose content mentions the basename
of any changed file, catching most import-style dependencies).

Pure Node.js HTTP server. Shells out to the system `git` binary (the
Dockerfile installs it).

## Run standalone

```bash
node examples/blast-radius/server.mjs &
curl -sX POST http://localhost:4113/analyze \
  -H 'content-type: application/json' \
  -d '{"repo_url":"https://github.com/sindresorhus/slugify","base_branch":"HEAD~5","head_ref":"HEAD"}' | jq .summary
```

## Run via Floom

```bash
node examples/blast-radius/server.mjs &
FLOOM_APPS_CONFIG=examples/blast-radius/apps.yaml \
  DATA_DIR=/tmp/floom-blast-radius \
  node apps/server/dist/index.js &
curl -sX POST http://localhost:3051/api/blast-radius/run \
  -H 'content-type: application/json' \
  -d '{"action":"analyze","inputs":{"repo_url":"https://github.com/sindresorhus/slugify"}}' | jq
```

## Docker

```bash
docker build -t floom-example-blast-radius -f examples/blast-radius/Dockerfile examples/blast-radius
docker run -p 4113:4113 floom-example-blast-radius
```

## Notes

- The server validates `repo_url` is `https://` with a clean hostname and
  sanitizes refs to `[A-Za-z0-9._/~^-]+` to prevent command injection via git
  args.
- Clone depth is capped at 50 commits so massive repos stay under a minute.
- File walking is capped at 2000 source files and 500KB per file to keep
  response times predictable.
