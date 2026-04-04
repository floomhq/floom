import { mutation, query, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { validateManifestStructure } from "./lib/manifest";

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

// All automations visible to the caller: own + org-public.
// No code returned — code is on the version record.
export const list = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthorized");

    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) =>
        q.eq("clerkUserId", identity.subject)
      )
      .unique();
    if (!user) throw new Error("User not found");

    const orgId = user.orgId;

    // All automations in this workspace, filtered by visibility:
    // - private (isPublicToOrg=false): only shown to their creator
    // - public (isPublicToOrg=true): shown to all workspace members
    const all = await ctx.db
      .query("automations")
      .withIndex("by_orgId", (q) => q.eq("orgId", orgId))
      .collect();

    const visible = all.filter(
      (a) => a.createdBy === user._id || a.isPublicToOrg
    );

    const sorted = visible.sort((a, b) => b.createdAt - a.createdAt);

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

        return {
          ...a,
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
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthorized");

    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) =>
        q.eq("clerkUserId", identity.subject)
      )
      .unique();
    if (!user) throw new Error("User not found");

    const automation = await ctx.db.get(args.id);
    if (!automation) return null;

    // Access check: owner or org member with isPublicToOrg
    if (
      automation.createdBy !== user._id &&
      !(automation.isPublicToOrg && automation.orgId === user.orgId)
    ) {
      throw new Error("Forbidden");
    }

    // Fetch current version (manifest for run form)
    const version =
      automation.currentVersionId !== "placeholder"
        ? await ctx.db.get(automation.currentVersionId)
        : null;

    // 20 most recent runs
    const runs = await ctx.db
      .query("runs")
      .withIndex("by_automationId_startedAt", (q) =>
        q.eq("automationId", args.id)
      )
      .order("desc")
      .take(20);

    return {
      ...automation,
      manifest: version?.manifest ?? null,
      runs,
      isOwner: automation.createdBy === user._id,
    };
  },
});

export const getInternal = internalQuery({
  args: { id: v.id("automations") },
  handler: async (ctx, args) => {
    return ctx.db.get(args.id);
  },
});

// Version history for an automation.
export const getVersions = query({
  args: { automationId: v.id("automations") },
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
    if (!automation) return [];

    if (
      automation.createdBy !== user._id &&
      !(automation.isPublicToOrg && automation.orgId === user.orgId)
    ) {
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
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthorized");

    const version = await ctx.db.get(args.versionId);
    if (!version) return null;

    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) =>
        q.eq("clerkUserId", identity.subject)
      )
      .unique();
    if (!user) throw new Error("User not found");

    const automation = await ctx.db.get(version.automationId);
    if (!automation) return null;

    if (
      automation.createdBy !== user._id &&
      !(automation.isPublicToOrg && automation.orgId === user.orgId)
    ) {
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
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthorized");

    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) =>
        q.eq("clerkUserId", identity.subject)
      )
      .unique();
    if (!user) throw new Error("User not found");

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
      createdBy: user._id,
      orgId: user.orgId,
      isPublicToOrg: false,
      createdAt: Date.now(),
      status: "active",
      schedule: manifest.schedule ?? null,
      scheduleInputs: manifest.scheduleInputs ?? null,
      // Temporary placeholder — will be patched below
      currentVersionId: "placeholder" as const,
      currentVersion: 1,
    });

    // Create version 1
    const versionId = await ctx.db.insert("automationVersions", {
      automationId,
      version: 1,
      code: args.code,
      manifest: args.manifest,
      createdAt: Date.now(),
      createdBy: user._id,
      changeNote: args.changeNote ?? null,
    });

    // Patch the automation with the real versionId
    await ctx.db.patch(automationId, { currentVersionId: versionId });

    return {
      id: automationId,
      currentVersion: 1,
    };
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
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthorized");

    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) =>
        q.eq("clerkUserId", identity.subject)
      )
      .unique();
    if (!user) throw new Error("User not found");

    const automation = await ctx.db.get(args.id);
    if (!automation) throw new Error("Automation not found");
    if (automation.createdBy !== user._id) throw new Error("Forbidden");

    const manifest = args.manifest as { name?: string; description?: string };

    // Validate
    const validationError = validateManifestStructure(
      args.code,
      args.manifest as Parameters<typeof validateManifestStructure>[1]
    );
    if (validationError) {
      throw new Error(`Validation failed: ${validationError.message}`);
    }

    const newVersion = automation.currentVersion + 1;

    const versionId = await ctx.db.insert("automationVersions", {
      automationId: args.id,
      version: newVersion,
      code: args.code,
      manifest: args.manifest,
      createdAt: Date.now(),
      createdBy: user._id,
      changeNote: args.changeNote ?? null,
    });

    await ctx.db.patch(args.id, {
      currentVersionId: versionId,
      currentVersion: newVersion,
      // Update name/description if manifest changed
      ...(manifest.name ? { name: manifest.name } : {}),
      ...(manifest.description ? { description: manifest.description } : {}),
    });

    return { id: args.id, currentVersion: newVersion };
  },
});

// Pause/resume scheduled runs. No new version created.
export const setScheduleEnabled = mutation({
  args: {
    id: v.id("automations"),
    enabled: v.boolean(),
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

    const automation = await ctx.db.get(args.id);
    if (!automation) throw new Error("Automation not found");
    if (automation.createdBy !== user._id) throw new Error("Forbidden");

    await ctx.db.patch(args.id, { scheduleEnabled: args.enabled });
    return { id: args.id, scheduleEnabled: args.enabled };
  },
});

// Visibility toggle. No new version created.
export const setPublic = mutation({
  args: {
    id: v.id("automations"),
    isPublicToOrg: v.boolean(),
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

    const automation = await ctx.db.get(args.id);
    if (!automation) throw new Error("Automation not found");
    if (automation.createdBy !== user._id) throw new Error("Forbidden");

    await ctx.db.patch(args.id, { isPublicToOrg: args.isPublicToOrg });
    return { id: args.id, isPublicToOrg: args.isPublicToOrg };
  },
});

// Delete automation + all versions and runs.
export const remove = mutation({
  args: { id: v.id("automations") },
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

    const automation = await ctx.db.get(args.id);
    if (!automation) throw new Error("Automation not found");
    if (automation.createdBy !== user._id) throw new Error("Forbidden");

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

    // Delete the automation itself
    await ctx.db.delete(args.id);

    return { success: true };
  },
});

// Org gallery — isPublicToOrg=true automations for the caller's org.
export const gallery = query({
  args: {
    q: v.optional(v.string()),
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

    let automations = await ctx.db
      .query("automations")
      .withIndex("by_orgId_isPublicToOrg", (q) =>
        q.eq("orgId", user.orgId).eq("isPublicToOrg", true)
      )
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
  },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) =>
        q.eq("clerkUserId", args.clerkUserId)
      )
      .unique();
    if (!user) throw new Error("User not found");

    const manifest = args.manifest as ManifestArg;

    const validationError = validateManifestStructure(args.code, manifest as Parameters<typeof validateManifestStructure>[1]);
    if (validationError) {
      throw new Error(`Validation failed: ${validationError.message}`);
    }

    const automationId = await ctx.db.insert("automations", {
      name: manifest.name,
      description: manifest.description,
      createdBy: user._id,
      orgId: user.orgId,
      isPublicToOrg: false,
      createdAt: Date.now(),
      status: "active",
      schedule: manifest.schedule ?? null,
      scheduleInputs: manifest.scheduleInputs ?? null,
      currentVersionId: "placeholder" as const,
      currentVersion: 1,
    });

    const versionId = await ctx.db.insert("automationVersions", {
      automationId,
      version: 1,
      code: args.code,
      manifest: args.manifest,
      createdAt: Date.now(),
      createdBy: user._id,
      changeNote: args.changeNote ?? null,
    });

    await ctx.db.patch(automationId, { currentVersionId: versionId });

    return { id: automationId, currentVersion: 1 };
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
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) =>
        q.eq("clerkUserId", args.clerkUserId)
      )
      .unique();
    if (!user) throw new Error("User not found");

    const automation = await ctx.db.get(args.id);
    if (!automation) throw new Error("Automation not found");
    if (automation.createdBy !== user._id) throw new Error("Forbidden");

    const manifest = args.manifest as ManifestArg;

    const validationError = validateManifestStructure(args.code, manifest as Parameters<typeof validateManifestStructure>[1]);
    if (validationError) {
      throw new Error(`Validation failed: ${validationError.message}`);
    }

    const newVersion = automation.currentVersion + 1;

    const versionId = await ctx.db.insert("automationVersions", {
      automationId: args.id,
      version: newVersion,
      code: args.code,
      manifest: args.manifest,
      createdAt: Date.now(),
      createdBy: user._id,
      changeNote: args.changeNote ?? null,
    });

    await ctx.db.patch(args.id, {
      currentVersionId: versionId,
      currentVersion: newVersion,
      ...(manifest.name ? { name: manifest.name } : {}),
      ...(manifest.description ? { description: manifest.description } : {}),
    });

    return { id: args.id, currentVersion: newVersion };
  },
});
