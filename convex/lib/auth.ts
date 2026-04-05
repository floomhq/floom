import { MutationCtx, QueryCtx, ActionCtx } from "../_generated/server";
import { Id } from "../_generated/dataModel";

export type AuthedUser = {
  userId: string;
  orgId: Id<"organizations">;
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

  const userId = identity.tokenIdentifier;
  const clerkOrgId =
    (identity as { org_id?: string }).org_id ?? identity.tokenIdentifier;

  // Look up the org - it should exist from the upsert on login
  const org = await (ctx as QueryCtx).db
    .query("organizations")
    .withIndex("by_clerkOrgId", (q: any) => q.eq("clerkOrgId", clerkOrgId))
    .unique();

  if (!org) {
    throw new Error("Organization not found. Please reload the page.");
  }

  return { userId, orgId: org._id };
}
