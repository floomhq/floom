import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

const http = httpRouter();

// Helper: verify floom_... API key from Authorization header.
// SHA-256 hashes the key and looks it up in the apiKeys table.
async function verifyApiKey(
  request: Request,
  ctx: { runQuery: Function }
): Promise<{ orgId: Id<"organizations">; keyId: Id<"apiKeys">; keyName: string }> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw new Error("Missing Authorization header");
  }
  const rawKey = authHeader.slice(7).trim();

  const encoded = new TextEncoder().encode(rawKey);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  const hashedKey = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const apiKey = await ctx.runQuery(internal.apiKeys.getByHashedKey, {
    hashedKey,
  });
  if (!apiKey) throw new Error("Invalid API key");
  if (apiKey.revokedAt) throw new Error("API key has been revoked");

  return { orgId: apiKey.orgId, keyId: apiKey._id, keyName: apiKey.name };
}

const DEFAULT_WAIT_SECONDS = 10;
const MAX_WAIT_SECONDS = 10;

function parseWaitSeconds(body: { wait?: unknown }): number {
  if (body.wait === undefined || body.wait === null) return DEFAULT_WAIT_SECONDS;
  const n = Number(body.wait);
  if (isNaN(n) || n < 0) return 0;
  return Math.min(n, MAX_WAIT_SECONDS);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

// POST /api/test — run code in sandbox before deploying.
http.route({
  path: "/api/test",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const { orgId } = await verifyApiKey(request, ctx);

      const body = (await request.json()) as {
        code: string;
        manifest: unknown;
        inputs: unknown;
        automationId?: string;
        wait?: number;
      };

      if (!body.code || !body.manifest) {
        return errorResponse("code and manifest are required");
      }

      const result = await ctx.runMutation(
        internal.testRuns.triggerTestInternal,
        {
          orgId,
          code: body.code,
          manifest: body.manifest,
          inputs: body.inputs ?? {},
          automationId: body.automationId
            ? (body.automationId as Id<"automations">)
            : undefined,
        }
      );

      const waitSecs = parseWaitSeconds(body);
      if (waitSecs > 0) {
        try {
          const doc = await ctx.runAction(
            internal.lib.waitForResult.waitForTestRun,
            { testRunId: result.testRunId, waitMs: waitSecs * 1000 }
          );
          if (doc && ["success", "error", "timeout"].includes(doc.status)) {
            return jsonResponse({ testRunId: result.testRunId, status: doc.status, result: doc });
          }
          return jsonResponse({ testRunId: result.testRunId, status: doc?.status ?? "pending" });
        } catch {
          // Wait failed — fall back to returning just the ID
          return jsonResponse({ testRunId: result.testRunId });
        }
      }

      return jsonResponse({ testRunId: result.testRunId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      if (msg.includes("Unauthorized") || msg.includes("Invalid API key") || msg.includes("revoked")) {
        return errorResponse(msg, 401);
      }
      return errorResponse(msg, 400);
    }
  }),
});

// GET /api/test-runs/:id — poll test run status.
http.route({
  pathPrefix: "/api/test-runs/",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    try {
      const url = new URL(request.url);
      const testRunId = url.pathname.split("/")[3];
      if (!testRunId) return errorResponse("Test run ID required");

      const { orgId } = await verifyApiKey(request, ctx);

      const testRun = await ctx.runQuery(internal.testRuns.getInternal, {
        testRunId: testRunId as Id<"testRuns">,
      });

      if (!testRun || testRun.orgId !== orgId) {
        return errorResponse("Test run not found", 404);
      }

      return jsonResponse(testRun);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      return errorResponse(msg, 400);
    }
  }),
});

// POST /api/deploy — deploy from a successful test run.
http.route({
  path: "/api/deploy",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const { orgId, keyName } = await verifyApiKey(request, ctx);

      const body = (await request.json()) as {
        testRunId: string;
        changeNote?: string;
      };

      if (!body.testRunId) {
        return errorResponse("testRunId is required");
      }

      // Fetch and validate the test run
      const testRun = await ctx.runQuery(internal.testRuns.getInternal, {
        testRunId: body.testRunId as Id<"testRuns">,
      });

      if (!testRun || testRun.orgId !== orgId) {
        return errorResponse("Test run not found", 404);
      }
      if (testRun.status !== "success") {
        return errorResponse("Test run did not succeed", 400);
      }
      if (testRun.usedAt) {
        return errorResponse("Test run already deployed", 400);
      }

      // Deploy using code from the test run
      const result = await ctx.runMutation(internal.automations.deployInternal, {
        code: testRun.code,
        manifest: testRun.manifest,
        changeNote: body.changeNote,
        clerkUserId: "api:" + keyName,
        orgId,
      });

      // Mark test run as consumed
      await ctx.runMutation(internal.testRuns.markUsed, {
        testRunId: body.testRunId as Id<"testRuns">,
      });

      const platformUrl =
        process.env.NEXT_PUBLIC_APP_URL ?? "https://dashboard.floom.dev";

      return jsonResponse({
        id: result.id,
        url: `${platformUrl}/a/${result.id}`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      if (msg.includes("Unauthorized") || msg.includes("Invalid API key") || msg.includes("revoked")) {
        return errorResponse(msg, 401);
      }
      return errorResponse(msg, 400);
    }
  }),
});

// POST /api/automations/:id/update|run|rollback — skill updates, triggers, or rolls back automation.
http.route({
  pathPrefix: "/api/automations/",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const url = new URL(request.url);
      const parts = url.pathname.split("/");
      // /api/automations/{id}/update
      const automationId = parts[3];
      const action = parts[4];

      if (!automationId) return errorResponse("Automation ID required");

      const { orgId, keyName } = await verifyApiKey(request, ctx);

      const body = (await request.json()) as {
        testRunId?: string;
        code?: string;
        manifest?: unknown;
        changeNote?: string;
        inputs?: unknown;
        versionId?: string;
        wait?: number;
      };

      if (action === "update") {
        if (!body.testRunId) {
          return errorResponse("testRunId is required");
        }

        // Fetch and validate the test run
        const testRun = await ctx.runQuery(internal.testRuns.getInternal, {
          testRunId: body.testRunId as Id<"testRuns">,
        });

        if (!testRun || testRun.orgId !== orgId) {
          return errorResponse("Test run not found", 404);
        }
        if (testRun.status !== "success") {
          return errorResponse("Test run did not succeed", 400);
        }
        if (testRun.usedAt) {
          return errorResponse("Test run already deployed", 400);
        }

        // If test run was linked to an automation, verify it matches
        if (testRun.automationId && testRun.automationId !== automationId) {
          return errorResponse("Test run was for a different automation", 400);
        }

        // Verify org ownership of the automation
        const automation = await ctx.runQuery(internal.automations.getInternal, {
          id: automationId as Id<"automations">,
        });
        if (!automation || automation.orgId !== orgId) {
          return errorResponse("Forbidden", 403);
        }

        const result = await ctx.runMutation(internal.automations.updateInternal, {
          id: automationId as Id<"automations">,
          code: testRun.code,
          manifest: testRun.manifest,
          changeNote: body.changeNote,
          clerkUserId: "api:" + keyName,
        });

        // Mark test run as consumed
        await ctx.runMutation(internal.testRuns.markUsed, {
          testRunId: body.testRunId as Id<"testRuns">,
        });

        return jsonResponse(result);
      }

      if (action === "run") {
        const result = await ctx.runMutation(internal.runs.triggerInternal, {
          automationId: automationId as Id<"automations">,
          inputs: body.inputs ?? {},
          triggeredBy: "skill",
          clerkUserId: "api:" + keyName,
          orgId,
        });

        const waitSecs = parseWaitSeconds(body);
        if (waitSecs > 0) {
          try {
            const doc = await ctx.runAction(
              internal.lib.waitForResult.waitForRun,
              { runId: result.runId, waitMs: waitSecs * 1000 }
            );
            if (doc && ["success", "error", "timeout"].includes(doc.status)) {
              return jsonResponse({ runId: result.runId, status: doc.status, result: doc });
            }
            return jsonResponse({ runId: result.runId, status: doc?.status ?? "pending" });
          } catch {
            return jsonResponse(result);
          }
        }

        return jsonResponse(result);
      }

      if (action === "rollback") {
        if (!body.versionId) {
          return errorResponse("versionId is required");
        }

        const result = await ctx.runMutation(
          internal.automations.rollbackInternal,
          {
            id: automationId as Id<"automations">,
            versionId: body.versionId as Id<"automationVersions">,
            orgId,
          }
        );

        return jsonResponse(result);
      }

      return errorResponse("Unknown action", 404);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      if (msg.includes("Unauthorized") || msg.includes("Invalid API key") || msg.includes("revoked")) {
        return errorResponse(msg, 401);
      }
      if (msg.includes("Forbidden")) return errorResponse(msg, 403);
      return errorResponse(msg, 400);
    }
  }),
});

// POST /api/secrets — skill stores an org secret.
http.route({
  path: "/api/secrets",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const { orgId } = await verifyApiKey(request, ctx);

      const body = (await request.json()) as { name: string; value: string };
      if (!body.name || !body.value) return errorResponse("name and value are required");

      const result = await ctx.runMutation(internal.secrets.upsertInternal, {
        orgId,
        name: body.name,
        value: body.value,
      });

      return jsonResponse(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      if (msg.includes("Unauthorized") || msg.includes("Invalid API key") || msg.includes("revoked")) {
        return errorResponse(msg, 401);
      }
      return errorResponse(msg, 400);
    }
  }),
});

// GET /api/runs/:runId — skill polls run status.
http.route({
  pathPrefix: "/api/runs/",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    try {
      const url = new URL(request.url);
      const runId = url.pathname.split("/")[3];
      if (!runId) return errorResponse("Run ID required");

      const { orgId } = await verifyApiKey(request, ctx);

      const run = await ctx.runQuery(internal.runs.getInternal, {
        runId: runId as Id<"runs">,
      });

      if (!run) return errorResponse("Run not found", 404);

      // Verify the run belongs to the API key's org
      const automation = await ctx.runQuery(internal.automations.getInternal, {
        id: run.automationId,
      });
      if (!automation || automation.orgId !== orgId) {
        return errorResponse("Run not found", 404);
      }

      return jsonResponse(run);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      return errorResponse(msg, 400);
    }
  }),
});

export default http;
