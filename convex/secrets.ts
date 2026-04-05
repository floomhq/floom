import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { v } from "convex/values";
import { encrypt, decrypt } from "./lib/crypto";
import { requireAuth } from "./lib/auth";

function getEncryptionKey(): string {
  const key = process.env.SECRETS_ENCRYPTION_KEY;
  if (!key) throw new Error("SECRETS_ENCRYPTION_KEY env var not set");
  return key;
}

// Store or update an org-scoped secret (AES-256 encrypted).
export const upsert = mutation({
  args: {
    name: v.string(),
    value: v.string(),
  },
  handler: async (ctx, args) => {
    const { userId, orgId } = await requireAuth(ctx);

    const encryptionKey = getEncryptionKey();
    const encryptedValue = await encrypt(args.value, encryptionKey);

    // Check for existing secret with this name in this org
    const existing = await ctx.db
      .query("secrets")
      .withIndex("by_orgId_name", (q) =>
        q.eq("orgId", orgId).eq("name", args.name)
      )
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, { encryptedValue });
    } else {
      await ctx.db.insert("secrets", {
        orgId,
        name: args.name,
        encryptedValue,
        createdAt: Date.now(),
      });
    }

    return { name: args.name, stored: true };
  },
});

// Delete an org secret.
export const remove = mutation({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    const { userId, orgId } = await requireAuth(ctx);

    const secret = await ctx.db
      .query("secrets")
      .withIndex("by_orgId_name", (q) =>
        q.eq("orgId", orgId).eq("name", args.name)
      )
      .unique();

    if (!secret) throw new Error("Secret not found");

    await ctx.db.delete(secret._id);
    return { deleted: true };
  },
});

// List secret names only — never decrypted values.
export const list = query({
  handler: async (ctx) => {
    const { userId, orgId } = await requireAuth(ctx);

    const secrets = await ctx.db
      .query("secrets")
      .withIndex("by_orgId", (q) => q.eq("orgId", orgId))
      .collect();

    return secrets
      .map((s) => ({ name: s.name, createdAt: s.createdAt }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});

// Internal: store a secret by org (used by HTTP action).
export const upsertInternal = internalMutation({
  args: {
    orgId: v.id("organizations"),
    name: v.string(),
    value: v.string(),
  },
  handler: async (ctx, args) => {
    const encryptionKey = getEncryptionKey();
    const encryptedValue = await encrypt(args.value, encryptionKey);

    const existing = await ctx.db
      .query("secrets")
      .withIndex("by_orgId_name", (q) =>
        q.eq("orgId", args.orgId).eq("name", args.name)
      )
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, { encryptedValue });
    } else {
      await ctx.db.insert("secrets", {
        orgId: args.orgId,
        name: args.name,
        encryptedValue,
        createdAt: Date.now(),
      });
    }

    return { name: args.name, stored: true };
  },
});

// Internal: decrypt all org secrets for E2B execution.
// Returns Record<name, decrypted_value>.
export const listDecrypted = internalQuery({
  args: { automationId: v.id("automations") },
  handler: async (ctx, args) => {
    const automation = await ctx.db.get(args.automationId);
    if (!automation) return {};

    const secrets = await ctx.db
      .query("secrets")
      .withIndex("by_orgId", (q) => q.eq("orgId", automation.orgId))
      .collect();

    const encryptionKey = getEncryptionKey();
    const decrypted: Record<string, string> = {};

    for (const secret of secrets) {
      try {
        decrypted[secret.name] = await decrypt(
          secret.encryptedValue,
          encryptionKey
        );
      } catch {
        // Skip corrupted entries
      }
    }

    return decrypted;
  },
});

// Internal: decrypt all org secrets by orgId directly.
// Used by test runs which may not have an automationId.
export const listDecryptedByOrg = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const secrets = await ctx.db
      .query("secrets")
      .withIndex("by_orgId", (q) => q.eq("orgId", args.orgId))
      .collect();

    const encryptionKey = getEncryptionKey();
    const decrypted: Record<string, string> = {};

    for (const secret of secrets) {
      try {
        decrypted[secret.name] = await decrypt(
          secret.encryptedValue,
          encryptionKey
        );
      } catch {
        // Skip corrupted entries
      }
    }

    return decrypted;
  },
});
