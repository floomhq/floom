import { internalQuery, mutation, query } from "./_generated/server";
import { v } from "convex/values";

async function hashKey(key: string): Promise<string> {
  const encoded = new TextEncoder().encode(key);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function generateRawKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return (
    "floom_" +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}

// Create a new API key for an org. Returns the full key (shown once).
export const create = mutation({
  args: {
    orgId: v.id("organizations"),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthorized");

    // Verify org exists
    const org = await ctx.db.get(args.orgId);
    if (!org) throw new Error("Organization not found");

    const rawKey = generateRawKey();
    const prefix = rawKey.slice(0, 12);
    const hashedKey = await hashKey(rawKey);

    await ctx.db.insert("apiKeys", {
      orgId: args.orgId,
      name: args.name,
      prefix,
      hashedKey,
      createdBy: identity.tokenIdentifier,
      createdAt: Date.now(),
    });

    return rawKey; // Full key, shown once
  },
});

// List all API keys for an org (prefixes only, never full keys).
export const list = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];

    const keys = await ctx.db
      .query("apiKeys")
      .withIndex("by_orgId", (q) => q.eq("orgId", args.orgId))
      .collect();

    return keys.map((k) => ({
      _id: k._id,
      name: k.name,
      prefix: k.prefix,
      createdAt: k.createdAt,
      revokedAt: k.revokedAt ?? null,
    }));
  },
});

// Revoke an API key (soft delete).
export const revoke = mutation({
  args: { keyId: v.id("apiKeys") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthorized");

    const key = await ctx.db.get(args.keyId);
    if (!key) throw new Error("API key not found");

    // Already revoked? No-op.
    if (key.revokedAt) return;

    await ctx.db.patch(args.keyId, { revokedAt: Date.now() });
  },
});

// Internal: look up an API key by its hash. Used by HTTP auth.
export const getByHashedKey = internalQuery({
  args: { hashedKey: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("apiKeys")
      .withIndex("by_hashedKey", (q) => q.eq("hashedKey", args.hashedKey))
      .unique();
  },
});
