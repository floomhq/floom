"use node";

import { internalAction } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";

const POLL_INTERVAL_MS = 500;
const TERMINAL_STATUSES = ["success", "error", "timeout"];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const waitForTestRun = internalAction({
  args: {
    testRunId: v.id("testRuns"),
    waitMs: v.number(),
  },
  handler: async (ctx, args) => {
    const deadline = Date.now() + args.waitMs;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      const doc = await ctx.runQuery(internal.testRuns.getInternal, {
        testRunId: args.testRunId,
      });
      if (doc && TERMINAL_STATUSES.includes(doc.status)) {
        return doc;
      }
    }
    // Final check before giving up
    return await ctx.runQuery(internal.testRuns.getInternal, {
      testRunId: args.testRunId,
    });
  },
});

export const waitForRun = internalAction({
  args: {
    runId: v.id("runs"),
    waitMs: v.number(),
  },
  handler: async (ctx, args) => {
    const deadline = Date.now() + args.waitMs;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      const doc = await ctx.runQuery(internal.runs.getInternal, {
        runId: args.runId,
      });
      if (doc && TERMINAL_STATUSES.includes(doc.status)) {
        return doc;
      }
    }
    return await ctx.runQuery(internal.runs.getInternal, {
      runId: args.runId,
    });
  },
});
