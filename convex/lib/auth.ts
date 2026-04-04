import { MutationCtx, QueryCtx, ActionCtx } from "../_generated/server";

export type AuthedUser = {
  userId: string; // Clerk user ID (identity.subject)
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

  const userId = identity.subject;
  // Clerk puts orgId in the "org_id" claim via JWT template
  const orgId =
    (identity as { org_id?: string }).org_id ?? identity.tokenIdentifier;

  return { userId, orgId };
}
