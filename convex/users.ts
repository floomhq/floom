import { internalQuery, mutation, query } from "./_generated/server";
import { v } from "convex/values";

function generateKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return "dsk_" + Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Called from Clerk webhook on user creation / org membership change.
// Also called from the frontend on first authenticated load (upsert pattern).
export const upsert = mutation({
  args: {
    clerkUserId: v.string(),
    email: v.string(),
    orgId: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", args.clerkUserId))
      .unique();

    if (existing) {
      // Update orgId if it changed (user switched orgs in Clerk)
      if (existing.orgId !== args.orgId) {
        await ctx.db.patch(existing._id, { orgId: args.orgId });
      }
      return existing._id;
    }

    return await ctx.db.insert("users", {
      clerkUserId: args.clerkUserId,
      email: args.email,
      orgId: args.orgId,
      createdAt: Date.now(),
    });
  },
});

// Generate (or regenerate) the CLI API key for the current user.
export const generateApiKey = mutation({
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthorized");

    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", identity.subject))
      .unique();
    if (!user) throw new Error("User not found");

    const apiKey = generateKey();
    await ctx.db.patch(user._id, { apiKey });
    return apiKey;
  },
});

// Return the current user's API key (masked for display).
export const getApiKey = query({
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", identity.subject))
      .unique();
    return user?.apiKey ?? null;
  },
});

// Internal: look up a user by their CLI API key.
export const getByApiKey = internalQuery({
  args: { apiKey: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("users")
      .withIndex("by_apiKey", (q) => q.eq("apiKey", args.apiKey))
      .unique();
  },
});

export const getByClerkId = query({
  args: { clerkUserId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", args.clerkUserId))
      .unique();
  },
});
