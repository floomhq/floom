import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // Immutable code+manifest blobs. Created once, referenced by testRuns and automationVersions.
  artifacts: defineTable({
    orgId: v.id("organizations"),
    code: v.string(),
    manifest: v.any(),
    createdAt: v.number(),
    createdBy: v.string(),
  })
    .index("by_org", ["orgId"])
    .index("by_created_at", ["createdAt"]),

  // Automation metadata + current version pointer.
  // Code lives in automationVersions.
  automations: defineTable({
    name: v.string(),
    description: v.string(),
    createdBy: v.string(), // Clerk user ID
    orgId: v.id("organizations"),
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
    // Publishing fields — flat model for v1
    publishedSlug: v.optional(v.string()),
    publishAccess: v.optional(v.union(v.literal("public"), v.literal("email"))),
    allowedEmails: v.optional(v.array(v.string())),
    publishedAt: v.optional(v.number()),
  })
    .index("by_orgId", ["orgId"])
    .index("by_createdBy", ["createdBy"])
    .index("by_publishedSlug", ["publishedSlug"]),

  // Immutable snapshot at each deploy/update. Code lives in artifacts.
  automationVersions: defineTable({
    automationId: v.id("automations"),
    version: v.number(),
    artifactId: v.id("artifacts"),
    createdAt: v.number(),
    createdBy: v.string(), // Clerk user ID
    changeNote: v.union(v.string(), v.null()),
  }).index("by_automationId", ["automationId"]),

  // Run records — each references the exact version that executed.
  runs: defineTable({
    automationId: v.id("automations"),
    versionId: v.id("automationVersions"),
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
      v.literal("schedule"),
      v.literal("published")
    ),
    viewToken: v.optional(v.string()),
    durationMs: v.union(v.number(), v.null()),
    startedAt: v.number(),
    finishedAt: v.union(v.number(), v.null()),
  })
    .index("by_automationId", ["automationId"])
    .index("by_automationId_startedAt", ["automationId", "startedAt"]),

  // Organizations — synced from Clerk or auto-created for personal accounts.
  organizations: defineTable({
    clerkOrgId: v.string(),
    name: v.string(),
    createdAt: v.number(),
    createdBy: v.string(),
  }).index("by_clerkOrgId", ["clerkOrgId"]),

  // Org-scoped API keys. SHA-256 hashed. Full key shown once on creation.
  apiKeys: defineTable({
    orgId: v.id("organizations"),
    name: v.string(),
    prefix: v.string(),
    hashedKey: v.string(),
    createdBy: v.string(),
    createdAt: v.number(),
    revokedAt: v.optional(v.number()),
  })
    .index("by_hashedKey", ["hashedKey"])
    .index("by_orgId", ["orgId"]),

  // Users — synced from Clerk on first login.
  users: defineTable({
    email: v.string(),
    clerkUserId: v.string(),
    createdAt: v.number(),
  }).index("by_clerkUserId", ["clerkUserId"]),

  // Test runs — sandbox execution of code before deploying as a version.
  // Code lives in artifacts. Counts toward rate limits.
  testRuns: defineTable({
    orgId: v.id("organizations"),
    automationId: v.optional(v.id("automations")), // present when testing update
    artifactId: v.id("artifacts"),
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
    durationMs: v.union(v.number(), v.null()),
    startedAt: v.number(),
    finishedAt: v.union(v.number(), v.null()),
  })
    .index("by_orgId_startedAt", ["orgId", "startedAt"])
    .index("by_automationId", ["automationId"]),

  // Org-scoped secrets. AES-256 encrypted. Never returned to frontend.
  secrets: defineTable({
    orgId: v.id("organizations"),
    name: v.string(),
    encryptedValue: v.string(),
    createdAt: v.number(),
  })
    .index("by_orgId", ["orgId"])
    .index("by_orgId_name", ["orgId", "name"]),
});
