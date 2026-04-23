# Security and sandboxing

Floom's launch-week security story is **container isolation plus explicit secret handling**, not a certification story. This page describes what the current code does.

## Isolation model (sandboxing)

- Each hosted run is a **fresh Docker container** (Linux namespaces and cgroups; default runtime is the usual OCI `runc`).
- Inputs are materialized on the host and mounted **read-only** under `/floom/inputs`.
- Self-hosters may point Docker at **`runsc` (gVisor)** for stronger isolation — an **operator** setting, not a Floom UI toggle. No Firecracker or per-tenant micro-VMs in this repo.

## How secrets are passed

- App secrets are injected into the run container as **environment variables at container start**.
- Secrets are **not baked into the Docker image** for a run.
- Saved secrets use **AES-256-GCM** in the app database (an encrypted store in SQLite, not HashiCorp Vault) with a per-workspace key wrapped under `FLOOM_MASTER_KEY`.

## Bring your own key (BYOK)

- The three launch demos accept a caller-supplied Gemini key after the free demo quota is used up.
- The web client stores that key in the browser's **localStorage** and sends it on the request as `X-User-Api-Key`.
- The server injects it for **that one run only** and does not persist it as a saved secret.

## What Floom sees

- Floom sees the app manifest, run inputs, run outputs, and app stdout/stderr that are captured into run logs.
- If an app prints a secret to stdout or stderr, Floom will capture that log line. App authors still need to avoid logging secrets.

## Run and log retention

- This repo does **not** implement an automatic run-retention or log-deletion sweeper today.
- Retention is operator-controlled on the deployed instance.
- Self-hosters own their own cleanup and deletion policy.

## What Floom does not claim

- No **SOC 2** line item, HSM, or third-party vault integration in the default path.
- Cloud-side “encryption at rest + per-run injection” does not mean the operator can never use saved secrets; do not read it as a promise of total operator blindness.

## Operator responsibilities

- Back up the database **and** the `FLOOM_MASTER_KEY` material together.
- If you self-host without setting `FLOOM_MASTER_KEY`, Floom will generate one in the data directory on first boot.
- Rotating the master key is an operator job, not an automatic background process.

## Related pages

- [/docs/limits](/docs/limits)
- [/docs/observability](/docs/observability)
- [/docs/ownership](/docs/ownership)
- [/docs/reliability](/docs/reliability)
