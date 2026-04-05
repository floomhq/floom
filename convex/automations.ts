import { mutation, query, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { validateManifestStructure } from "./lib/manifest";
import { requireAuth } from "./lib/auth";

function isOwner(createdBy: string, userId: string): boolean {
  return createdBy === userId || userId.endsWith(`|${createdBy}`);
}

type ManifestArg = {
  name: string;
  description: string;
  schedule?: string | null;
  scheduleInputs?: Record<string, unknown> | null;
  inputs: Array<{ name: string; label: string; type: string }>;
  outputs: Array<{ name: string; label: string; type: string }>;
  secrets_needed?: string[];
  python_dependencies?: string[];
  manifest_version?: string;
};

// All automations in the caller's org.
// No code returned — code is on the version record.
export const list = query({
  args: {},
  handler: async (ctx) => {
    const { userId, orgId } = await requireAuth(ctx);

    const all = await ctx.db
      .query("automations")
      .withIndex("by_orgId", (q) => q.eq("orgId", orgId))
      .collect();

    const sorted = all.sort((a, b) => b.createdAt - a.createdAt);

    // Enrich each automation with last run info
    const enriched = await Promise.all(
      sorted.map(async (a) => {
        const lastRun = await ctx.db
          .query("runs")
          .withIndex("by_automationId_startedAt", (q) =>
            q.eq("automationId", a._id)
          )
          .order("desc")
          .first();

        const versionDoc = a.currentVersionId !== "placeholder"
          ? await ctx.db.get(a.currentVersionId)
          : null;

        return {
          ...a,
          currentVersion: versionDoc?.version ?? 1,
          lastRunStatus: lastRun?.status ?? null,
          lastRunAt: lastRun?.startedAt ?? null,
        };
      })
    );

    return enriched;
  },
});

// Automation detail + 20 most recent runs.
export const get = query({
  args: { id: v.id("automations") },
  handler: async (ctx, args) => {
    const { userId, orgId } = await requireAuth(ctx);

    const automation = await ctx.db.get(args.id);
    if (!automation) return null;

    // Access check: must belong to caller's org
    if (automation.orgId !== orgId) {
      throw new Error("Forbidden");
    }

    // Fetch current version (manifest for run form)
    const version =
      automation.currentVersionId !== "placeholder"
        ? await ctx.db.get(automation.currentVersionId)
        : null;

    // 20 most recent runs
    const rawRuns = await ctx.db
      .query("runs")
      .withIndex("by_automationId_startedAt", (q) =>
        q.eq("automationId", args.id)
      )
      .order("desc")
      .take(20);

    // Enrich runs with version number from version doc
    const versionCache = new Map<string, number>();
    const runs = await Promise.all(
      rawRuns.map(async (r) => {
        let ver = versionCache.get(r.versionId);
        if (ver === undefined) {
          const doc = await ctx.db.get(r.versionId);
          ver = doc?.version ?? 1;
          versionCache.set(r.versionId, ver);
        }
        return { ...r, version: ver };
      })
    );

    return {
      ...automation,
      currentVersion: version?.version ?? 1,
      manifest: version?.manifest ?? null,
      runs,
      isOwner: isOwner(automation.createdBy, userId),
    };
  },
});

export const getInternal = internalQuery({
  args: { id: v.id("automations") },
  handler: async (ctx, args) => {
    return ctx.db.get(args.id);
  },
});

// Full automation detail + code — called from HTTP action (bearer token auth).
export const getDetailInternal = internalQuery({
  args: {
    id: v.id("automations"),
    orgId: v.id("organizations"),
  },
  handler: async (ctx, args) => {
    const automation = await ctx.db.get(args.id);
    if (!automation) return null;
    if (automation.orgId !== args.orgId) return null;

    const version =
      automation.currentVersionId !== "placeholder"
        ? await ctx.db.get(automation.currentVersionId)
        : null;

    return {
      id: automation._id,
      name: automation.name,
      description: automation.description,
      status: automation.status,
      schedule: automation.schedule,
      scheduleEnabled: automation.scheduleEnabled ?? true,
      createdAt: automation.createdAt,
      currentVersion: version?.version ?? 1,
      code: version?.code ?? null,
      manifest: version?.manifest ?? null,
    };
  },
});

// List automations for an org — called from HTTP action (bearer token auth).
export const listInternal = internalQuery({
  args: {
    orgId: v.id("organizations"),
    q: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    let automations = await ctx.db
      .query("automations")
      .withIndex("by_orgId", (q) => q.eq("orgId", args.orgId))
      .collect();

    if (args.q) {
      const q = args.q.toLowerCase();
      automations = automations.filter(
        (a) =>
          a.name.toLowerCase().includes(q) ||
          a.description.toLowerCase().includes(q)
      );
    }

    const sorted = automations.sort((a, b) => b.createdAt - a.createdAt);

    const enriched = await Promise.all(
      sorted.map(async (a) => {
        const lastRun = await ctx.db
          .query("runs")
          .withIndex("by_automationId_startedAt", (q) =>
            q.eq("automationId", a._id)
          )
          .order("desc")
          .first();

        const versionDoc =
          a.currentVersionId !== "placeholder"
            ? await ctx.db.get(a.currentVersionId)
            : null;

        return {
          id: a._id,
          name: a.name,
          description: a.description,
          status: a.status,
          schedule: a.schedule,
          scheduleEnabled: a.scheduleEnabled ?? true,
          currentVersion: versionDoc?.version ?? 1,
          createdAt: a.createdAt,
          lastRunStatus: lastRun?.status ?? null,
          lastRunAt: lastRun?.startedAt ?? null,
        };
      })
    );

    return enriched;
  },
});

// Version history for an automation.
export const getVersions = query({
  args: { automationId: v.id("automations") },
  handler: async (ctx, args) => {
    const { userId, orgId } = await requireAuth(ctx);

    const automation = await ctx.db.get(args.automationId);
    if (!automation) return [];

    if (automation.orgId !== orgId) {
      throw new Error("Forbidden");
    }

    const versions = await ctx.db
      .query("automationVersions")
      .withIndex("by_automationId", (q) =>
        q.eq("automationId", args.automationId)
      )
      .order("desc")
      .collect();

    // Count runs per version
    const allRuns = await ctx.db
      .query("runs")
      .withIndex("by_automationId", (q) =>
        q.eq("automationId", args.automationId)
      )
      .collect();

    const runCounts: Record<string, number> = {};
    for (const run of allRuns) {
      const vid = run.versionId as string;
      runCounts[vid] = (runCounts[vid] ?? 0) + 1;
    }

    return versions.map((v) => ({
      ...v,
      runCount: runCounts[v._id] ?? 0,
    }));
  },
});

// Code at a specific version — for "view code for this run".
export const getVersion = query({
  args: { versionId: v.id("automationVersions") },
  handler: async (ctx, args) => {
    const { userId, orgId } = await requireAuth(ctx);

    const version = await ctx.db.get(args.versionId);
    if (!version) return null;

    const automation = await ctx.db.get(version.automationId);
    if (!automation) return null;

    if (automation.orgId !== orgId) {
      throw new Error("Forbidden");
    }

    return version;
  },
});

// Create automation + version 1.
// Called from: frontend useMutation + HTTP action for skill CLI.
export const deploy = mutation({
  args: {
    code: v.string(),
    manifest: v.any(),
    changeNote: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { userId, orgId } = await requireAuth(ctx);

    const manifest = args.manifest as {
      name: string;
      description: string;
      schedule?: string | null;
      scheduleInputs?: Record<string, unknown> | null;
      inputs: Array<{ name: string; label: string; type: string }>;
      outputs: Array<{ name: string; label: string; type: string }>;
      secrets_needed?: string[];
    };

    // Validate manifest structure
    const validationError = validateManifestStructure(args.code, manifest as Parameters<typeof validateManifestStructure>[1]);
    if (validationError) {
      throw new Error(`Validation failed: ${validationError.message}`);
    }

    // Create a placeholder automation first so we have the ID
    const automationId = await ctx.db.insert("automations", {
      name: manifest.name,
      description: manifest.description,
      createdBy: userId,
      orgId,
      createdAt: Date.now(),
      status: "active",
      schedule: manifest.schedule ?? null,
      scheduleInputs: manifest.scheduleInputs ?? null,
      // Temporary placeholder — will be patched below
      currentVersionId: "placeholder" as const,
    });

    // Create version 1
    const versionId = await ctx.db.insert("automationVersions", {
      automationId,
      version: 1,
      code: args.code,
      manifest: args.manifest,
      createdAt: Date.now(),
      createdBy: userId,
      changeNote: args.changeNote ?? null,
    });

    // Patch the automation with the real versionId
    await ctx.db.patch(automationId, { currentVersionId: versionId });

    return { id: automationId };
  },
});

// Create new version, update currentVersionId.
// Called from: skill CLI HTTP action.
export const update = mutation({
  args: {
    id: v.id("automations"),
    code: v.string(),
    manifest: v.any(),
    changeNote: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { userId } = await requireAuth(ctx);

    const automation = await ctx.db.get(args.id);
    if (!automation) throw new Error("Automation not found");
    if (!isOwner(automation.createdBy, userId)) throw new Error("Forbidden");

    const manifest = args.manifest as { name?: string; description?: string };

    // Validate
    const validationError = validateManifestStructure(
      args.code,
      args.manifest as Parameters<typeof validateManifestStructure>[1]
    );
    if (validationError) {
      throw new Error(`Validation failed: ${validationError.message}`);
    }

    // Derive next version number from the current version doc
    const currentVersionDoc = automation.currentVersionId !== "placeholder"
      ? await ctx.db.get(automation.currentVersionId)
      : null;
    const newVersion = (currentVersionDoc?.version ?? 0) + 1;

    const versionId = await ctx.db.insert("automationVersions", {
      automationId: args.id,
      version: newVersion,
      code: args.code,
      manifest: args.manifest,
      createdAt: Date.now(),
      createdBy: userId,
      changeNote: args.changeNote ?? null,
    });

    await ctx.db.patch(args.id, {
      currentVersionId: versionId,
      // Update name/description if manifest changed
      ...(manifest.name ? { name: manifest.name } : {}),
      ...(manifest.description ? { description: manifest.description } : {}),
    });

    return { id: args.id };
  },
});

// Pause/resume scheduled runs. No new version created.
export const setScheduleEnabled = mutation({
  args: {
    id: v.id("automations"),
    enabled: v.boolean(),
  },
  handler: async (ctx, args) => {
    const { userId } = await requireAuth(ctx);

    const automation = await ctx.db.get(args.id);
    if (!automation) throw new Error("Automation not found");
    if (!isOwner(automation.createdBy, userId)) throw new Error("Forbidden");

    await ctx.db.patch(args.id, { scheduleEnabled: args.enabled });
    return { id: args.id, scheduleEnabled: args.enabled };
  },
});

// Delete automation + all versions and runs.
export const remove = mutation({
  args: { id: v.id("automations") },
  handler: async (ctx, args) => {
    const { orgId } = await requireAuth(ctx);

    const automation = await ctx.db.get(args.id);
    if (!automation) throw new Error("Automation not found");
    if (automation.orgId !== orgId) throw new Error("Forbidden");

    // Delete all versions
    const versions = await ctx.db
      .query("automationVersions")
      .withIndex("by_automationId", (q) => q.eq("automationId", args.id))
      .collect();
    for (const version of versions) {
      await ctx.db.delete(version._id);
    }

    // Delete all runs
    const runs = await ctx.db
      .query("runs")
      .withIndex("by_automationId", (q) => q.eq("automationId", args.id))
      .collect();
    for (const run of runs) {
      await ctx.db.delete(run._id);
    }

    // Delete all test runs
    const testRuns = await ctx.db
      .query("testRuns")
      .withIndex("by_automationId", (q) => q.eq("automationId", args.id))
      .collect();
    for (const testRun of testRuns) {
      await ctx.db.delete(testRun._id);
    }

    // Delete the automation itself
    await ctx.db.delete(args.id);

    return { success: true };
  },
});

// Org gallery — all automations for the caller's org.
export const gallery = query({
  args: {
    q: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { orgId } = await requireAuth(ctx);

    let automations = await ctx.db
      .query("automations")
      .withIndex("by_orgId", (q) => q.eq("orgId", orgId))
      .collect();

    // Text search on name + description
    if (args.q) {
      const q = args.q.toLowerCase();
      automations = automations.filter(
        (a) =>
          a.name.toLowerCase().includes(q) ||
          a.description.toLowerCase().includes(q)
      );
    }

    // Sort by most recently active (most recent run first, then createdAt)
    return automations.sort((a, b) => b.createdAt - a.createdAt);
  },
});

// Rollback to a previous version.
export const rollback = mutation({
  args: {
    id: v.id("automations"),
    versionId: v.id("automationVersions"),
  },
  handler: async (ctx, args) => {
    const { userId, orgId } = await requireAuth(ctx);

    const automation = await ctx.db.get(args.id);
    if (!automation) throw new Error("Automation not found");
    if (automation.orgId !== orgId) throw new Error("Forbidden");

    const version = await ctx.db.get(args.versionId);
    if (!version) throw new Error("Version not found");
    if (version.automationId !== args.id) {
      throw new Error("Version does not belong to this automation");
    }

    await ctx.db.patch(args.id, { currentVersionId: args.versionId });

    return { id: args.id, currentVersion: version.version };
  },
});

// Internal rollback — called from HTTP action (bearer token auth).
export const rollbackInternal = internalMutation({
  args: {
    id: v.id("automations"),
    versionId: v.id("automationVersions"),
    orgId: v.id("organizations"),
  },
  handler: async (ctx, args) => {
    const automation = await ctx.db.get(args.id);
    if (!automation) throw new Error("Automation not found");
    if (automation.orgId !== args.orgId) throw new Error("Forbidden");

    const version = await ctx.db.get(args.versionId);
    if (!version) throw new Error("Version not found");
    if (version.automationId !== args.id) {
      throw new Error("Version does not belong to this automation");
    }

    await ctx.db.patch(args.id, { currentVersionId: args.versionId });

    return { id: args.id, currentVersion: version.version };
  },
});

// Internal: check if a scheduled run is already in progress (cron dedup).
// Returns true if a run exists with status=running for this automation.
export const hasRunningRun = internalMutation({
  args: { automationId: v.id("automations") },
  handler: async (ctx, args) => {
    const runningRun = await ctx.db
      .query("runs")
      .withIndex("by_automationId", (q) =>
        q.eq("automationId", args.automationId)
      )
      .filter((q) => q.eq(q.field("status"), "running"))
      .first();

    return runningRun !== null;
  },
});

// Internal: deploy mutation called from HTTP action (bearer token auth).
export const deployInternal = internalMutation({
  args: {
    code: v.string(),
    manifest: v.any(),
    changeNote: v.optional(v.string()),
    clerkUserId: v.string(),
    orgId: v.id("organizations"),
  },
  handler: async (ctx, args) => {
    const manifest = args.manifest as ManifestArg;

    const validationError = validateManifestStructure(args.code, manifest as Parameters<typeof validateManifestStructure>[1]);
    if (validationError) {
      throw new Error(`Validation failed: ${validationError.message}`);
    }

    const automationId = await ctx.db.insert("automations", {
      name: manifest.name,
      description: manifest.description,
      createdBy: args.clerkUserId,
      orgId: args.orgId,
      createdAt: Date.now(),
      status: "active",
      schedule: manifest.schedule ?? null,
      scheduleInputs: manifest.scheduleInputs ?? null,
      currentVersionId: "placeholder" as const,
    });

    const versionId = await ctx.db.insert("automationVersions", {
      automationId,
      version: 1,
      code: args.code,
      manifest: args.manifest,
      createdAt: Date.now(),
      createdBy: args.clerkUserId,
      changeNote: args.changeNote ?? null,
    });

    await ctx.db.patch(automationId, { currentVersionId: versionId });

    return { id: automationId };
  },
});

// Internal: update mutation called from HTTP action (bearer token auth).
export const updateInternal = internalMutation({
  args: {
    id: v.id("automations"),
    code: v.string(),
    manifest: v.any(),
    changeNote: v.optional(v.string()),
    clerkUserId: v.string(),
  },
  handler: async (ctx, args) => {
    const automation = await ctx.db.get(args.id);
    if (!automation) throw new Error("Automation not found");

    const manifest = args.manifest as ManifestArg;

    const validationError = validateManifestStructure(args.code, manifest as Parameters<typeof validateManifestStructure>[1]);
    if (validationError) {
      throw new Error(`Validation failed: ${validationError.message}`);
    }

    // Derive next version number from the current version doc
    const currentVersionDoc = automation.currentVersionId !== "placeholder"
      ? await ctx.db.get(automation.currentVersionId)
      : null;
    const newVersion = (currentVersionDoc?.version ?? 0) + 1;

    const versionId = await ctx.db.insert("automationVersions", {
      automationId: args.id,
      version: newVersion,
      code: args.code,
      manifest: args.manifest,
      createdAt: Date.now(),
      createdBy: args.clerkUserId,
      changeNote: args.changeNote ?? null,
    });

    await ctx.db.patch(args.id, {
      currentVersionId: versionId,
      ...(manifest.name ? { name: manifest.name } : {}),
      ...(manifest.description ? { description: manifest.description } : {}),
    });

    return { id: args.id };
  },
});
