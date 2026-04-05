import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { nanoid } from "nanoid";
import { requireAuth, optionalAuth } from "./lib/auth";
import { checkOrgRateLimit, checkPublishedRateLimit } from "./lib/rateLimit";

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
    const { userId, orgId } = await requireAuth(ctx);

    const automation = await ctx.db.get(args.automationId);
    if (!automation) throw new Error("Automation not found");

    // Access check: must belong to caller's org
    if (automation.orgId !== orgId) {
      throw new Error("Forbidden");
    }

    await checkOrgRateLimit(ctx, automation.orgId);

    const triggeredBy = args.triggeredBy ?? "manual";

    // Cron deduplication + pause check
    if (triggeredBy === "schedule") {
      if (automation.scheduleEnabled === false) {
        throw new Error("CRON_PAUSED: Scheduled runs are paused for this automation");
      }

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

    if (automation.currentVersionId === "placeholder") {
      throw new Error("Automation is still deploying");
    }

    // Create run record (status=pending)
    const runId = await ctx.db.insert("runs", {
      automationId: args.automationId,
      versionId: automation.currentVersionId as Id<"automationVersions">,
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
    const { userId, orgId } = await requireAuth(ctx);

    const run = await ctx.db.get(args.runId);
    if (!run) return null;

    const automation = await ctx.db.get(run.automationId);
    if (!automation) return null;

    if (automation.orgId !== orgId) {
      throw new Error("Forbidden");
    }

    const versionDoc = await ctx.db.get(run.versionId);
    return { ...run, version: versionDoc?.version ?? 1 };
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
          const creator = await ctx.db
            .query("users")
            .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", automation.createdBy))
            .unique();
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
    orgId: v.id("organizations"),
  },
  handler: async (ctx, args) => {
    const automation = await ctx.db.get(args.automationId);
    if (!automation) throw new Error("Automation not found");

    // Verify the automation belongs to the caller's org
    if (automation.orgId !== args.orgId) {
      throw new Error("Forbidden");
    }

    await checkOrgRateLimit(ctx, automation.orgId);

    if (automation.currentVersionId === "placeholder") {
      throw new Error("Automation is still deploying");
    }

    const triggeredBy = args.triggeredBy ?? "skill";

    const runId = await ctx.db.insert("runs", {
      automationId: args.automationId,
      versionId: automation.currentVersionId as Id<"automationVersions">,
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

// Public trigger for published automations — no auth required (email-gated access optional).
// Note: "published" triggeredBy is only set by this mutation, not by trigger() or triggerInternal().
export const triggerPublished = mutation({
  args: {
    slug: v.string(),
    inputs: v.any(),
  },
  handler: async (ctx, args) => {
    // Look up automation by slug
    const automation = await ctx.db
      .query("automations")
      .withIndex("by_publishedSlug", (q) => q.eq("publishedSlug", args.slug))
      .first();

    if (!automation || !automation.publishedAt)
      throw new Error("Automation not found");
    if (automation.status !== "active")
      throw new Error("Automation is temporarily unavailable");
    if (automation.currentVersionId === "placeholder")
      throw new Error("Automation is still deploying");

    // Validate inputs is a plain object (public endpoint, untrusted input)
    if (args.inputs !== null && typeof args.inputs === "object" && !Array.isArray(args.inputs)) {
      // OK — plain object
    } else if (args.inputs === null || args.inputs === undefined) {
      // OK — no inputs
    } else {
      throw new Error("Invalid inputs: expected an object");
    }

    // Email-gated access check
    if (automation.publishAccess === "email") {
      const auth = await optionalAuth(ctx);
      if (!auth?.email) throw new Error("Sign in required");
      if (!automation.allowedEmails?.some(e => e.toLowerCase() === auth.email!.toLowerCase()))
        throw new Error("Access denied");
    }

    // Rate limits
    await checkPublishedRateLimit(ctx, automation._id);
    await checkOrgRateLimit(ctx, automation.orgId);

    // Generate viewToken
    const viewToken = nanoid(21);

    const runId = await ctx.db.insert("runs", {
      automationId: automation._id,
      versionId: automation.currentVersionId as Id<"automationVersions">,
      inputs: args.inputs,
      outputs: null,
      logs: "",
      status: "pending",
      errorType: null,
      error: null,
      triggeredBy: "published",
      viewToken,
      durationMs: null,
      startedAt: Date.now(),
      finishedAt: null,
    });

    await ctx.scheduler.runAfter(0, internal.executor.executeRun, { runId });

    return { runId, viewToken };
  },
});

// Public query for published run results — auth via viewToken, not session.
export const getPublishedRun = query({
  args: {
    runId: v.id("runs"),
    viewToken: v.string(),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) return null;
    if (run.triggeredBy !== "published" || run.viewToken !== args.viewToken)
      return null;

    return {
      status: run.status,
      outputs: run.outputs,
      logs: run.logs,
      error: run.error,
      errorType: run.errorType,
      durationMs: run.durationMs,
    };
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
