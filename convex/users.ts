import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// Called from the frontend on first authenticated load (upsert pattern).
export const upsert = mutation({
  args: {
    email: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthorized");

    const tokenId = identity.tokenIdentifier;

    // Upsert user
    const existing = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", tokenId))
      .unique();

    const userId = existing
      ? existing._id
      : await ctx.db.insert("users", {
          clerkUserId: tokenId,
          email: args.email,
          createdAt: Date.now(),
        });

    // Upsert organization
    const clerkOrgId =
      (identity as { org_id?: string }).org_id ?? tokenId;
    const orgName =
      (identity as { org_name?: string }).org_name ?? "Personal";

    let org = await ctx.db
      .query("organizations")
      .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", clerkOrgId))
      .unique();

    if (!org) {
      const orgId = await ctx.db.insert("organizations", {
        clerkOrgId,
        name: orgName,
        createdAt: Date.now(),
        createdBy: tokenId,
      });
      org = await ctx.db.get(orgId);
    }

    return { userId, orgId: org!._id };
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
