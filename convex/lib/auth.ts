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

// Same as requireAuth but returns null instead of throwing when not authenticated.
// Used by published automation queries that need optional auth.
export async function optionalAuth(
  ctx: QueryCtx | MutationCtx
): Promise<(AuthedUser & { email?: string }) | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;

  const userId = identity.tokenIdentifier;
  const email = identity.email ?? undefined;
  const clerkOrgId =
    (identity as { org_id?: string }).org_id ?? identity.tokenIdentifier;

  const org = await (ctx as QueryCtx).db
    .query("organizations")
    .withIndex("by_clerkOrgId", (q: any) => q.eq("clerkOrgId", clerkOrgId))
    .unique();

  if (!org) return null;

  return { userId, orgId: org._id, email };
}
