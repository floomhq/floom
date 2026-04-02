import { MutationCtx, QueryCtx, ActionCtx } from "../_generated/server";

export type AuthedUser = {
  userId: string; // Convex users._id
  clerkUserId: string;
  orgId: string;
};

// Shared auth helper for Convex functions (queries/mutations/actions).
// Extracts userId + orgId from Clerk JWT via ctx.auth.
export async function requireAuth(
  ctx: QueryCtx | MutationCtx | ActionCtx
): Promise<AuthedUser> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new Error("Unauthorized");
  }

  // Clerk puts orgId in the "org_id" claim via JWT template
  const clerkUserId = identity.subject;
  const orgId =
    (identity as { org_id?: string }).org_id ?? identity.tokenIdentifier;

  // Look up the Convex user record
  // We use a workaround since ActionCtx doesn't have db directly
  // For queries/mutations: use db. For actions: use ctx.runQuery.
  if ("db" in ctx) {
    const user = await (ctx as QueryCtx | MutationCtx).db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", clerkUserId))
      .unique();

    if (!user) {
      throw new Error("User not found — sign in first");
    }

    return { userId: user._id, clerkUserId, orgId };
  }

  // For actions, caller must pass userId or use a separate query
  return { userId: "action-context" as string, clerkUserId, orgId };
}
