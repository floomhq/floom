import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { validateManifestStructure } from "./lib/manifest";

// Create an artifact — validates manifest, stores code+manifest blob.
export const create = internalMutation({
  args: {
    orgId: v.id("organizations"),
    code: v.string(),
    manifest: v.any(),
    createdBy: v.string(),
  },
  handler: async (ctx, args) => {
    const manifest = args.manifest as Parameters<typeof validateManifestStructure>[1];
    const validationError = validateManifestStructure(args.code, manifest);
    if (validationError) {
      throw new Error(`Validation failed: ${validationError.message}`);
    }

    const artifactId = await ctx.db.insert("artifacts", {
      orgId: args.orgId,
      code: args.code,
      manifest: args.manifest,
      createdAt: Date.now(),
      createdBy: args.createdBy,
    });

    return { artifactId };
  },
});

// Get an artifact by ID.
export const get = internalQuery({
  args: { id: v.id("artifacts") },
  handler: async (ctx, args) => {
    return ctx.db.get(args.id);
  },
});
