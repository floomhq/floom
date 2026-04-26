# Studio GitHub Deploy

ADR-015 launch scope is public repositories first. Creators paste a public GitHub URL on `/studio/build`; Floom validates the repo, clones it, finds `floom.yaml`, builds a Docker image, and publishes the app as private.

## Endpoint

```http
POST /api/studio/build/from-github
Content-Type: application/json

{
  "github_url": "https://github.com/owner/repo",
  "branch": "main",
  "name": "Optional display name",
  "slug": "optional-slug",
  "manifest_path": "examples/my-app/floom.yaml"
}
```

Accepted URL forms:

- `https://github.com/<owner>/<repo>`
- `https://github.com/<owner>/<repo>/tree/<branch>`

Private repositories are not in v1 launch scope. A private or missing repo returns:

```json
{
  "code": "repo_private_or_missing",
  "error": "repo private or doesn't exist; for private repos install Floom GitHub App (coming week 1)"
}
```

If the repo contains more than one manifest, the endpoint returns `409` with `manifest_paths`. Re-call the endpoint with the chosen `manifest_path`.

Successful requests return immediately while the Docker build continues:

```json
{
  "slug": null,
  "build_id": "bld_...",
  "status": "publishing",
  "edit_url": null
}
```

Poll status:

```http
GET /api/studio/build/:build_id
```

Statuses are `detecting`, `cloning`, `building`, `publishing`, `published`, and `error`.

## Manifest Lookup

Floom looks for:

- `floom.yaml`
- `examples/<dirname>/floom.yaml`

Multi-app repositories use the second form. `manifest_path` only accepts those two shapes.

## Webhook Rebuilds

Public-repo launch uses opt-in GitHub webhooks. The GitHub App will automate this in the week-1 post-launch scope.

1. Set `FLOOM_GITHUB_WEBHOOK_SECRET` on the Floom server.
2. In GitHub, open the repository settings.
3. Add a webhook:
   - Payload URL: `https://<your-floom-host>/api/studio/build/github-webhook`
   - Content type: `application/json`
   - Secret: the exact `FLOOM_GITHUB_WEBHOOK_SECRET` value
   - Events: `Just the push event`
4. Save.

On a signed `push`, Floom rebuilds the latest published build for that repo and branch. Pushes to other branches are ignored until that branch has its own published build.

## Scope Boundary

This flow does not implement GitHub App OAuth, GitHub App installation, private-repo cloning, or PAT paste fallback. Those remain separate post-launch work.
