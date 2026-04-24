# Launch Demo Recovery

## Symptom

The launch demo app returns an `app_unavailable` error even though the slug exists in the `apps` table.

## Likely Cause

The AX41 host pruned one or more `floom-demo-*` Docker images after the app rows were already pointing at those tags. The DB row remains, but the image tag no longer exists locally, so runs fail.

## Quick Recovery

Restart the preview container on AX41 so boot-time seeding re-checks the demo images and rebuilds any missing tags:

```bash
docker restart floom-mcp-preview
```

## Verification

1. Confirm the three launch-demo images exist on the host:

```bash
docker images | grep floom-demo
```

2. Verify the output shows three rows whose tags match the `apps.docker_image` values for:
   `lead-scorer`, `competitor-analyzer`, `resume-screener`

## Prevention

- PR #724 adds the recovery and defensive guard so launch-demo rows do not advance to a missing image tag and existing rows are marked `inactive` when no runnable tag remains.
- Do not run `docker image prune` on the AX41 host unless the `floom-demo-*` tags are excluded or otherwise preserved.

## Escalation

If `docker restart floom-mcp-preview` does not rebuild the missing image:

1. Check `/var/log/floom-deploy-prod.log` for launch-demo seeding or Docker build failures.
2. Check `journalctl` for container/runtime errors on AX41.
