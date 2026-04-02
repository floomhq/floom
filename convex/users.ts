import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

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

export const getByClerkId = query({
  args: { clerkUserId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", args.clerkUserId))
      .unique();
  },
});
