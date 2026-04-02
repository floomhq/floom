import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";

// Public trigger — mutation (not action) so we have db for auth + rate limit.
// Mutations can schedule background actions via ctx.scheduler.runAfter().
export const trigger = mutation({
  args: {
    automationId: v.id("automations"),
    inputs: v.any(),
    triggeredBy: v.optional(
      v.union(v.literal("manual"), v.literal("skill"), v.literal("schedule"))
    ),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthorized");

    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) =>
        q.eq("clerkUserId", identity.subject)
      )
      .unique();
    if (!user) throw new Error("User not found");

    const automation = await ctx.db.get(args.automationId);
    if (!automation) throw new Error("Automation not found");

    // Access check: owner or org member if public
    if (
      automation.createdBy !== user._id &&
      !(automation.isPublicToOrg && automation.orgId === user.orgId)
    ) {
      throw new Error("Forbidden");
    }

    // Rate limit: 50 runs/hour per org (atomic — single-writer prevents races)
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const orgAutomations = await ctx.db
      .query("automations")
      .withIndex("by_orgId", (q) => q.eq("orgId", automation.orgId))
      .collect();

    let orgRunCount = 0;
    for (const a of orgAutomations) {
      const runs = await ctx.db
        .query("runs")
        .withIndex("by_automationId", (q) => q.eq("automationId", a._id))
        .filter((q) => q.gte(q.field("startedAt"), oneHourAgo))
        .collect();
      orgRunCount += runs.length;
    }

    if (orgRunCount >= 50) {
      throw new Error("Rate limit exceeded: 50 runs per hour per org");
    }

    const triggeredBy = args.triggeredBy ?? "manual";

    // Cron deduplication: skip if a run is already in progress
    if (triggeredBy === "schedule") {
      const runningRun = await ctx.db
        .query("runs")
        .withIndex("by_automationId", (q) =>
          q.eq("automationId", args.automationId)
        )
        .filter((q) => q.eq(q.field("status"), "running"))
        .first();

      if (runningRun) {
        throw new Error(
          "CRON_DEDUP: A run is already in progress for this automation"
        );
      }
    }

    // Create run record (status=pending)
    const runId = await ctx.db.insert("runs", {
      automationId: args.automationId,
      versionId: automation.currentVersionId,
      version: automation.currentVersion,
      inputs: args.inputs,
      outputs: null,
      logs: "",
      status: "pending",
      errorType: null,
      error: null,
      triggeredBy,
      durationMs: null,
      startedAt: Date.now(),
      finishedAt: null,
    });

    // Schedule E2B execution in background (executor.ts has "use node")
    await ctx.scheduler.runAfter(0, internal.executor.executeRun, { runId });

    return { runId };
  },
});

// Live run status — frontend subscribes with useQuery for real-time updates.
export const get = query({
  args: { runId: v.id("runs") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthorized");

    const run = await ctx.db.get(args.runId);
    if (!run) return null;

    const automation = await ctx.db.get(run.automationId);
    if (!automation) return null;

    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) =>
        q.eq("clerkUserId", identity.subject)
      )
      .unique();
    if (!user) throw new Error("User not found");

    if (
      automation.createdBy !== user._id &&
      !(automation.isPublicToOrg && automation.orgId === user.orgId)
    ) {
      throw new Error("Forbidden");
    }

    return run;
  },
});

// Internal queries — used by executor.ts (actions can't call db directly).
export const getInternal = internalQuery({
  args: { runId: v.id("runs") },
  handler: async (ctx, args) => ctx.db.get(args.runId),
});

export const getVersionInternal = internalQuery({
  args: { versionId: v.id("automationVersions") },
  handler: async (ctx, args) => ctx.db.get(args.versionId),
});

// Internal mutations called by executor.ts to update run state.
export const updateRunStatus = internalMutation({
  args: {
    runId: v.id("runs"),
    status: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("success"),
      v.literal("error"),
      v.literal("timeout")
    ),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.runId, { status: args.status });
  },
});

export const finishRun = internalMutation({
  args: {
    runId: v.id("runs"),
    status: v.union(
      v.literal("success"),
      v.literal("error"),
      v.literal("timeout")
    ),
    errorType: v.union(
      v.literal("timeout"),
      v.literal("syntax_error"),
      v.literal("runtime_error"),
      v.literal("missing_secret"),
      v.literal("sandbox_error"),
      v.null()
    ),
    error: v.union(v.string(), v.null()),
    outputs: v.union(v.any(), v.null()),
    logs: v.string(),
    durationMs: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.runId, {
      status: args.status,
      errorType: args.errorType,
      error: args.error,
      outputs: args.outputs,
      logs: args.logs,
      durationMs: args.durationMs,
      finishedAt: Date.now(),
    });

    // Send email notification for failed scheduled runs
    if (args.status !== "success") {
      const run = await ctx.db.get(args.runId);
      if (run?.triggeredBy === "schedule") {
        const automation = run ? await ctx.db.get(run.automationId) : null;
        if (automation) {
          const creator = await ctx.db.get(automation.createdBy);
          if (creator) {
            await ctx.scheduler.runAfter(
              0,
              internal.notifications.sendFailureEmail,
              {
                toEmail: creator.email,
                automationName: automation.name,
                automationId: automation._id,
                errorType: args.errorType ?? "runtime_error",
                error: args.error ?? "Unknown error",
              }
            );
          }
        }
      }
    }
  },
});

// Internal: trigger a run from HTTP action (bearer token auth, no Clerk session).
// Mirrors the public `trigger` mutation but accepts clerkUserId directly.
export const triggerInternal = internalMutation({
  args: {
    automationId: v.id("automations"),
    inputs: v.any(),
    triggeredBy: v.optional(
      v.union(v.literal("manual"), v.literal("skill"), v.literal("schedule"))
    ),
    clerkUserId: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) =>
        q.eq("clerkUserId", args.clerkUserId)
      )
      .unique();
    if (!user) throw new Error("User not found");

    const automation = await ctx.db.get(args.automationId);
    if (!automation) throw new Error("Automation not found");

    if (
      automation.createdBy !== user._id &&
      !(automation.isPublicToOrg && automation.orgId === user.orgId)
    ) {
      throw new Error("Forbidden");
    }

    // Rate limit: 50 runs/hour per org
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const orgAutomations = await ctx.db
      .query("automations")
      .withIndex("by_orgId", (q) => q.eq("orgId", automation.orgId))
      .collect();

    let orgRunCount = 0;
    for (const a of orgAutomations) {
      const runs = await ctx.db
        .query("runs")
        .withIndex("by_automationId", (q) => q.eq("automationId", a._id))
        .filter((q) => q.gte(q.field("startedAt"), oneHourAgo))
        .collect();
      orgRunCount += runs.length;
    }

    if (orgRunCount >= 50) {
      throw new Error("Rate limit exceeded: 50 runs per hour per org");
    }

    const triggeredBy = args.triggeredBy ?? "skill";

    const runId = await ctx.db.insert("runs", {
      automationId: args.automationId,
      versionId: automation.currentVersionId,
      version: automation.currentVersion,
      inputs: args.inputs,
      outputs: null,
      logs: "",
      status: "pending",
      errorType: null,
      error: null,
      triggeredBy,
      durationMs: null,
      startedAt: Date.now(),
      finishedAt: null,
    });

    await ctx.scheduler.runAfter(0, internal.executor.executeRun, { runId });

    return { runId };
  },
});

// Cron: mark stale running runs (>10 min) as sandbox_error.
export const cleanupStalledRuns = internalMutation({
  args: {},
  handler: async (ctx) => {
    const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
    const allRuns = await ctx.db.query("runs").collect();
    const stalled = allRuns.filter(
      (r) => r.status === "running" && r.startedAt < tenMinutesAgo
    );
    for (const run of stalled) {
      await ctx.db.patch(run._id, {
        status: "error",
        errorType: "sandbox_error",
        error: "Execution timed out — sandbox was unresponsive",
        finishedAt: Date.now(),
        durationMs: Date.now() - run.startedAt,
      });
    }
    return stalled.length;
  },
});
