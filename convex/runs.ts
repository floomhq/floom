import {
  action,
  internalAction,
  internalMutation,
  mutation,
  query,
} from "./_generated/server";
import { v } from "convex/values";
import { internal, api } from "./_generated/api";
import { decrypt } from "./lib/crypto";
import { selectE2BTemplate } from "./lib/manifest";

// Rate limit: 50 runs/hour per org.
// Must be a mutation — atomic single-writer model prevents race conditions.
const triggerRun = mutation({
  args: {
    automationId: v.id("automations"),
    inputs: v.any(),
    triggeredBy: v.union(
      v.literal("manual"),
      v.literal("skill"),
      v.literal("schedule")
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

    // Access check
    if (
      automation.createdBy !== user._id &&
      !(automation.isPublicToOrg && automation.orgId === user.orgId)
    ) {
      throw new Error("Forbidden");
    }

    // Rate limit: 50 runs/hour per org
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const recentRuns = await ctx.db
      .query("runs")
      .withIndex("by_automationId", (q) =>
        q.eq("automationId", args.automationId)
      )
      .filter((q) => q.gte(q.field("startedAt"), oneHourAgo))
      .collect();

    // Get org-wide count across all automations
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
      triggeredBy: args.triggeredBy,
      durationMs: null,
      startedAt: Date.now(),
      finishedAt: null,
    });

    return runId;
  },
});

// Public trigger — creates run + schedules background execution.
export const trigger = action({
  args: {
    automationId: v.id("automations"),
    inputs: v.any(),
    triggeredBy: v.optional(
      v.union(v.literal("manual"), v.literal("skill"), v.literal("schedule"))
    ),
  },
  handler: async (ctx, args) => {
    const runId = await ctx.runMutation(internal.runs.triggerRun, {
      automationId: args.automationId,
      inputs: args.inputs,
      triggeredBy: args.triggeredBy ?? "manual",
    });

    // Schedule background execution immediately
    await ctx.scheduler.runAfter(0, internal.runs.executeRun, { runId });

    return { runId };
  },
});

// Live run status — frontend subscribes with useQuery.
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

// Internal: creates run record atomically (used by trigger action).
export const triggerRun = internalMutation({
  args: {
    automationId: v.id("automations"),
    inputs: v.any(),
    triggeredBy: v.union(
      v.literal("manual"),
      v.literal("skill"),
      v.literal("schedule")
    ),
  },
  handler: async (ctx, args) => {
    const automation = await ctx.db.get(args.automationId);
    if (!automation) throw new Error("Automation not found");

    // Cron deduplication: skip if a run is already in progress
    if (args.triggeredBy === "schedule") {
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

    return await ctx.db.insert("runs", {
      automationId: args.automationId,
      versionId: automation.currentVersionId,
      version: automation.currentVersion,
      inputs: args.inputs,
      outputs: null,
      logs: "",
      status: "pending",
      errorType: null,
      error: null,
      triggeredBy: args.triggeredBy,
      durationMs: null,
      startedAt: Date.now(),
      finishedAt: null,
    });
  },
});

// Internal: E2B execution — called by scheduler.
export const executeRun = internalAction({
  args: { runId: v.id("runs") },
  handler: async (ctx, args) => {
    const run = await ctx.runQuery(api.runs.getInternal, { runId: args.runId });
    if (!run) throw new Error("Run not found");

    // Mark as running
    await ctx.runMutation(internal.runs.updateRunStatus, {
      runId: args.runId,
      status: "running",
    });

    const startTime = Date.now();

    try {
      // Fetch version code
      const version = await ctx.runQuery(api.runs.getVersionInternal, {
        versionId: run.versionId,
      });
      if (!version) throw new Error("Version not found");

      const manifest = version.manifest as {
        python_dependencies?: string[];
        secrets_needed?: string[];
      };

      // Fetch and decrypt org secrets
      const orgSecrets = await ctx.runQuery(api.secrets.listDecrypted, {
        automationId: run.automationId,
      });

      // Check required secrets are present
      const secretsNeeded = manifest.secrets_needed ?? [];
      const missingSecrets = secretsNeeded.filter(
        (name) => !orgSecrets[name]
      );
      if (missingSecrets.length > 0) {
        await ctx.runMutation(internal.runs.finishRun, {
          runId: args.runId,
          status: "error",
          errorType: "missing_secret",
          error: `Missing secrets: ${missingSecrets.join(", ")}`,
          outputs: null,
          logs: "",
          durationMs: Date.now() - startTime,
        });
        return;
      }

      // Select E2B template
      const templateId = selectE2BTemplate(
        manifest.python_dependencies ?? []
      );

      // E2B glue code appended to user code
      const glueCode = `
import json as _json, sys as _sys

class _PlatformEncoder(_json.JSONEncoder):
    def default(self, obj):
        import datetime, decimal, uuid
        if isinstance(obj, (datetime.date, datetime.datetime)):
            return obj.isoformat()
        if isinstance(obj, decimal.Decimal):
            return float(obj)
        if isinstance(obj, uuid.UUID):
            return str(obj)
        try:
            import numpy as _np
            if isinstance(obj, _np.integer): return int(obj)
            if isinstance(obj, _np.floating): return float(obj)
            if isinstance(obj, _np.ndarray): return obj.tolist()
        except ImportError:
            pass
        return super().default(obj)

_inputs = _json.loads(_sys.argv[1])
_result = run(**_inputs)
print(_json.dumps(_result, cls=_PlatformEncoder))
`;

      const fullCode = version.code + "\n" + glueCode;
      const inputsJson = JSON.stringify(run.inputs ?? {});

      // Import E2B dynamically (only available in Node.js environment)
      const { Sandbox } = await import("e2b");

      const sandbox = await Sandbox.create(templateId, {
        envVars: orgSecrets as Record<string, string>,
        timeoutMs: 270_000, // 270s — 30s less than Convex action limit
      });

      let stdout = "";
      let stderr = "";

      try {
        // Write code to file and execute
        await sandbox.files.write("/tmp/automation.py", fullCode);
        const result = await sandbox.commands.run(
          `python /tmp/automation.py '${inputsJson.replace(/'/g, "'\\''")}'`,
          { timeoutMs: 265_000 }
        );
        stdout = result.stdout;
        stderr = result.stderr;

        if (result.exitCode !== 0) {
          throw new Error(stderr || `Process exited with code ${result.exitCode}`);
        }

        const outputs = JSON.parse(stdout.trim());
        const durationMs = Date.now() - startTime;

        await ctx.runMutation(internal.runs.finishRun, {
          runId: args.runId,
          status: "success",
          errorType: null,
          error: null,
          outputs,
          logs: stderr,
          durationMs,
        });
      } finally {
        await sandbox.kill().catch(() => {}); // best-effort cleanup
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const durationMs = Date.now() - startTime;

      let errorType: "timeout" | "syntax_error" | "runtime_error" | "sandbox_error" =
        "runtime_error";
      if (error.message.includes("timeout") || durationMs >= 270_000) {
        errorType = "timeout";
      } else if (error.message.includes("SyntaxError")) {
        errorType = "syntax_error";
      } else if (
        error.message.includes("Sandbox") ||
        error.message.includes("E2B")
      ) {
        errorType = "sandbox_error";
      }

      await ctx.runMutation(internal.runs.finishRun, {
        runId: args.runId,
        status: errorType === "timeout" ? "timeout" : "error",
        errorType,
        error: error.message,
        outputs: null,
        logs: "",
        durationMs,
      });
    }
  },
});

// Internal mutations for updating run state.
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

// Internal query helpers for actions (actions can't access db directly).
export const getInternal = query({
  args: { runId: v.id("runs") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.runId);
  },
});

export const getVersionInternal = query({
  args: { versionId: v.id("automationVersions") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.versionId);
  },
});

// Cron job: mark stale running runs as sandbox_error (orphan cleanup).
export const cleanupStalledRuns = internalMutation({
  args: {},
  handler: async (ctx) => {
    const tenMinutesAgo = Date.now() - 10 * 60 * 1000;

    // Find all runs still in "running" state started >10 minutes ago
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
