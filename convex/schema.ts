import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // Automation metadata + current version pointer.
  // Code lives in automationVersions.
  automations: defineTable({
    name: v.string(),
    description: v.string(),
    createdBy: v.id("users"),
    orgId: v.string(), // from Clerk JWT
    isPublicToOrg: v.boolean(),
    createdAt: v.number(),
    status: v.union(
      v.literal("active"),
      v.literal("deploying"),
      v.literal("failed")
    ),
    schedule: v.union(v.string(), v.null()),
    scheduleEnabled: v.optional(v.boolean()),
    scheduleInputs: v.union(v.any(), v.null()),
    currentVersionId: v.union(
      v.id("automationVersions"),
      v.literal("placeholder")
    ),
    currentVersion: v.number(),
  })
    .index("by_orgId", ["orgId"])
    .index("by_createdBy", ["createdBy"])
    .index("by_orgId_isPublicToOrg", ["orgId", "isPublicToOrg"]),

  // Immutable snapshot of code + manifest at each deploy/update.
  automationVersions: defineTable({
    automationId: v.id("automations"),
    version: v.number(),
    code: v.string(),
    manifest: v.any(),
    createdAt: v.number(),
    createdBy: v.id("users"),
    changeNote: v.union(v.string(), v.null()),
  }).index("by_automationId", ["automationId"]),

  // Run records — each references the exact version that executed.
  runs: defineTable({
    automationId: v.id("automations"),
    versionId: v.id("automationVersions"),
    version: v.number(),
    inputs: v.any(),
    outputs: v.union(v.any(), v.null()),
    logs: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("running"),
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
    triggeredBy: v.union(
      v.literal("manual"),
      v.literal("skill"),
      v.literal("schedule")
    ),
    durationMs: v.union(v.number(), v.null()),
    startedAt: v.number(),
    finishedAt: v.union(v.number(), v.null()),
  })
    .index("by_automationId", ["automationId"])
    .index("by_automationId_startedAt", ["automationId", "startedAt"]),

  // Users — synced from Clerk on first login.
  users: defineTable({
    email: v.string(),
    clerkUserId: v.string(),
    orgId: v.string(),
    createdAt: v.number(),
    apiKey: v.optional(v.string()), // dsk_... for CLI auth
  })
    .index("by_clerkUserId", ["clerkUserId"])
    .index("by_orgId", ["orgId"])
    .index("by_apiKey", ["apiKey"]),

  // Org-scoped secrets. AES-256 encrypted. Never returned to frontend.
  secrets: defineTable({
    orgId: v.string(),
    name: v.string(),
    encryptedValue: v.string(),
    createdAt: v.number(),
  })
    .index("by_orgId", ["orgId"])
    .index("by_orgId_name", ["orgId", "name"]),
});
