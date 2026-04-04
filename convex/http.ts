import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

const http = httpRouter();

// Helper: verify dsk_... API key from Authorization header.
// Looks up the user in Convex by their stored API key.
async function verifyClerkApiKey(
  request: Request,
  ctx: { runQuery: Function }
): Promise<{ clerkUserId: string; orgId: string }> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw new Error("Missing Authorization header");
  }
  const apiKey = authHeader.slice(7);

  const user = await ctx.runQuery(internal.users.getByApiKey, { apiKey });
  if (!user) throw new Error("Invalid API key");

  return { clerkUserId: user.clerkUserId, orgId: user.orgId };
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

// POST /api/deploy — skill deploys a new automation.
http.route({
  path: "/api/deploy",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const { clerkUserId } = await verifyClerkApiKey(request, ctx);

      // Ensure user exists in Convex
      const user = await ctx.runQuery(api.users.getByClerkId, { clerkUserId });
      if (!user) return errorResponse("User not found — sign in to the platform first", 401);

      const body = (await request.json()) as {
        code: string;
        manifest: unknown;
        changeNote?: string;
      };

      if (!body.code || !body.manifest) {
        return errorResponse("code and manifest are required");
      }

      // Run deploy mutation with system auth (since HTTP actions use bearer, not Clerk session)
      const result = await ctx.runMutation(internal.automations.deployInternal, {
        code: body.code,
        manifest: body.manifest,
        changeNote: body.changeNote,
        clerkUserId,
      });

      const platformUrl =
        process.env.NEXT_PUBLIC_APP_URL ?? "https://yourplatform.com";

      return jsonResponse({
        id: result.id,
        url: `${platformUrl}/a/${result.id}`,
        currentVersion: result.currentVersion,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      if (msg.includes("Unauthorized") || msg.includes("Invalid API key")) {
        return errorResponse(msg, 401);
      }
      return errorResponse(msg, 400);
    }
  }),
});

// POST /api/automations/:id/update|run — skill updates or triggers automation.
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

      const { clerkUserId } = await verifyClerkApiKey(request, ctx);
      const user = await ctx.runQuery(api.users.getByClerkId, { clerkUserId });
      if (!user) return errorResponse("User not found", 401);

      const body = (await request.json()) as {
        code?: string;
        manifest?: unknown;
        changeNote?: string;
        inputs?: unknown;
      };

      if (action === "update") {
        if (!body.code || !body.manifest) {
          return errorResponse("code and manifest are required");
        }

        const result = await ctx.runMutation(internal.automations.updateInternal, {
          id: automationId as Id<"automations">,
          code: body.code,
          manifest: body.manifest,
          changeNote: body.changeNote,
          clerkUserId,
        });

        return jsonResponse(result);
      }

      if (action === "run") {
        const result = await ctx.runMutation(internal.runs.triggerInternal, {
          automationId: automationId as Id<"automations">,
          inputs: body.inputs ?? {},
          triggeredBy: "skill",
          clerkUserId,
        });
        return jsonResponse(result);
      }

      return errorResponse("Unknown action", 404);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      if (msg.includes("Unauthorized") || msg.includes("Invalid API key")) {
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
      const { clerkUserId } = await verifyClerkApiKey(request, ctx);
      const user = await ctx.runQuery(api.users.getByClerkId, { clerkUserId });
      if (!user) return errorResponse("User not found", 401);

      const body = (await request.json()) as { name: string; value: string };
      if (!body.name || !body.value) return errorResponse("name and value are required");

      const result = await ctx.runMutation(internal.secrets.upsertInternal, {
        clerkUserId,
        name: body.name,
        value: body.value,
      });

      return jsonResponse(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      if (msg.includes("Unauthorized") || msg.includes("Invalid API key")) {
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

      const { clerkUserId } = await verifyClerkApiKey(request, ctx);
      const user = await ctx.runQuery(api.users.getByClerkId, { clerkUserId });
      if (!user) return errorResponse("User not found", 401);

      const run = await ctx.runQuery(internal.runs.getInternal, {
        runId: runId as Id<"runs">,
      });

      if (!run) return errorResponse("Run not found", 404);

      // Verify the run belongs to the user's org
      const automation = await ctx.runQuery(internal.automations.getInternal, {
        id: run.automationId,
      });
      if (!automation || automation.orgId !== user.orgId) {
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
