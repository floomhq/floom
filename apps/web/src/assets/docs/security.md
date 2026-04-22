# Security and sandboxing

Floom's launch-week security story is **container isolation plus explicit secret handling**, not a certification story. This page describes what the current code does.

## Isolation model

- Each hosted run starts a **fresh Docker container**.
- File inputs are materialized on the host, then mounted into the run container as **read-only** files under `/floom/inputs`.
- Floom does **not** currently advertise a separate micro-VM, gVisor, Firecracker, or per-tenant kernel isolation layer in this repo.

## How secrets are passed

- App secrets are injected into the run container as **environment variables at container start**.
- Secrets are **not baked into the Docker image** for a run.
- Creator-owned and user-owned saved secrets are stored encrypted in SQLite using **AES-256-GCM envelope encryption** with a per-workspace data-encryption key wrapped under `FLOOM_MASTER_KEY`.

## Bring your own key (BYOK)

- The three launch demos accept a caller-supplied Gemini key after the free demo quota is used up.
- The web client stores that key in the browser's **localStorage** and sends it on the request as `X-User-Api-Key`.
- The server injects it for **that one run only** and does not persist it as a saved secret.

## What Floom sees

- Floom sees the app manifest, run inputs, run outputs, and app stdout/stderr that are captured into run logs.
- If an app prints a secret to stdout or stderr, Floom will capture that log line. App authors still need to avoid logging secrets.

## What Floom does not claim

- No public **SOC 2** claim is shipped in this repo.
- No hardware security module or external vault integration is documented for the default deployment.
- No browser-side promise exists that Floom Cloud cannot access saved cloud-side secrets. The guarantee is about encryption at rest plus explicit per-run injection, not about operator invisibility.

## Operator responsibilities

- Back up the database **and** the `FLOOM_MASTER_KEY` material together.
- If you self-host without setting `FLOOM_MASTER_KEY`, Floom will generate one in the data directory on first boot.
- Rotating the master key is an operator job, not an automatic background process.

## Related pages

- [/docs/limits](/docs/limits)
- [/docs/observability](/docs/observability)
- [/docs/ownership](/docs/ownership)
- [/docs/reliability](/docs/reliability)
