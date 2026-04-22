# Ownership and export

Floom is designed so the app contract stays portable. This repo is honest about what is already shipped and what is not.

## What you own

- Your app code.
- Your OpenAPI spec.
- Your manifest and renderer code.
- Your self-host deployment if you run Floom on your own infrastructure.

## What is open source

- The runtime in this repo is **MIT licensed**.
- The self-host guide is public.
- The same broad runtime model used on `floom.dev` is available to self-hosters.

## Export and migration today

- There is **no verified one-click `floom export` CLI** in this repo today.
- The portable path today is straightforward but manual: keep your app code and spec in your own repo, then point a self-hosted Floom instance at the same manifest or OpenAPI input.
- For proxied apps, migration is mostly about moving the Floom layer, not rewriting the upstream API.

## If Floom Cloud is down

- Self-hosting remains the operator escape hatch.
- Your code and spec are still yours.
- This repo does not claim a magical cloud-to-cloud migration button today.

## Lock-in stance

- Floom adds surfaces around an app contract you already control.
- The repo does not position the cloud product as the only place your app can run.
- If you need full operator control, the answer is self-hosting, not a hidden enterprise-only export path.

## Related pages

- [/docs/security](/docs/security)
- [/docs/workflow](/docs/workflow)
- [/docs/reliability](/docs/reliability)
