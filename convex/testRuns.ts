import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { checkOrgRateLimit } from "./lib/rateLimit";

// Create a test run — checks rate limit, schedules executor.
// Manifest validation happens at artifact creation time.
export const triggerTestInternal = internalMutation({
  args: {
    orgId: v.id("organizations"),
    artifactId: v.id("artifacts"),
    inputs: v.any(),
    automationId: v.optional(v.id("automations")),
  },
  handler: async (ctx, args) => {
    // If testing an update, verify org ownership
    if (args.automationId) {
      const automation = await ctx.db.get(args.automationId);
      if (!automation || automation.orgId !== args.orgId) {
        throw new Error("Forbidden");
      }
    }

    await checkOrgRateLimit(ctx, args.orgId);

    const testRunId = await ctx.db.insert("testRuns", {
      orgId: args.orgId,
      automationId: args.automationId,
      artifactId: args.artifactId,
      inputs: args.inputs,
      outputs: null,
      logs: "",
      status: "pending",
      errorType: null,
      error: null,
      durationMs: null,
      startedAt: Date.now(),
      finishedAt: null,
    });

    await ctx.scheduler.runAfter(0, internal.executor.executeTestRun, {
      testRunId,
    });

    return { testRunId };
  },
});

export const getInternal = internalQuery({
  args: { testRunId: v.id("testRuns") },
  handler: async (ctx, args) => ctx.db.get(args.testRunId),
});

export const updateStatus = internalMutation({
  args: {
    testRunId: v.id("testRuns"),
    status: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("success"),
      v.literal("error"),
      v.literal("timeout")
    ),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.testRunId, { status: args.status });
  },
});

export const finishTestRun = internalMutation({
  args: {
    testRunId: v.id("testRuns"),
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
    await ctx.db.patch(args.testRunId, {
      status: args.status,
      errorType: args.errorType,
      error: args.error,
      outputs: args.outputs,
      logs: args.logs,
      durationMs: args.durationMs,
      finishedAt: Date.now(),
    });
    // No email notifications for test runs — user is watching interactively
  },
});

