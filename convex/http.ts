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
      const { orgId, keyName } = await verifyApiKey(request, ctx);

      const body = (await request.json()) as {
        code: string;
        manifest: unknown;
        changeNote?: string;
      };

      if (!body.code || !body.manifest) {
        return errorResponse("code and manifest are required");
      }

      const result = await ctx.runMutation(internal.automations.deployInternal, {
        code: body.code,
        manifest: body.manifest,
        changeNote: body.changeNote,
        clerkUserId: "api:" + keyName,
        orgId,
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

      const { orgId, keyName } = await verifyApiKey(request, ctx);

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

        // Verify org ownership
        const automation = await ctx.runQuery(internal.automations.getInternal, {
          id: automationId as Id<"automations">,
        });
        if (!automation || automation.orgId !== orgId) {
          return errorResponse("Forbidden", 403);
        }

        const result = await ctx.runMutation(internal.automations.updateInternal, {
          id: automationId as Id<"automations">,
          code: body.code,
          manifest: body.manifest,
          changeNote: body.changeNote,
          clerkUserId: "api:" + keyName,
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
