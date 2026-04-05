# TODOs

## Artifact Garbage Collection
- **What:** Delete orphaned artifacts older than 30 days with no linked testRun or automationVersion.
- **Why:** The agent fix loop creates ~5 artifacts per deploy attempt. Without GC, orphaned artifacts accumulate.
- **Context:** The `by_created_at` index on the artifacts table supports efficient querying by age. Implementation: scheduled Convex cron that queries old artifacts, checks for references, deletes orphans.
- **Depends on:** Artifacts table (this PR)
