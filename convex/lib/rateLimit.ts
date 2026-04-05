import { Id } from "../_generated/dataModel";
import { MutationCtx } from "../_generated/server";

const RATE_LIMIT = 50;
const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

/**
 * Check org rate limit across both runs and testRuns tables.
 * Throws if the org has exceeded 50 executions in the last hour.
 */
export async function checkOrgRateLimit(
  ctx: MutationCtx,
  orgId: Id<"organizations">
): Promise<void> {
  const oneHourAgo = Date.now() - RATE_WINDOW_MS;

  // Count runs via automations (runs don't have orgId directly)
  const orgAutomations = await ctx.db
    .query("automations")
    .withIndex("by_orgId", (q) => q.eq("orgId", orgId))
    .collect();

  let count = 0;
  for (const a of orgAutomations) {
    const runs = await ctx.db
      .query("runs")
      .withIndex("by_automationId", (q) => q.eq("automationId", a._id))
      .filter((q) => q.gte(q.field("startedAt"), oneHourAgo))
      .collect();
    count += runs.length;
  }

  // Count test runs directly (testRuns have orgId)
  const testRuns = await ctx.db
    .query("testRuns")
    .withIndex("by_orgId_startedAt", (q) =>
      q.eq("orgId", orgId).gte("startedAt", oneHourAgo)
    )
    .collect();
  count += testRuns.length;

  if (count >= RATE_LIMIT) {
    throw new Error("Rate limit exceeded: 50 runs per hour per org");
  }
}
