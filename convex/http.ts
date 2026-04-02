import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { api, internal } from "./_generated/api";

const http = httpRouter();

// Helper: verify Clerk API key from Authorization header.
// Returns { clerkUserId, orgId } or throws.
async function verifyClerkApiKey(
  request: Request
): Promise<{ clerkUserId: string; orgId: string }> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw new Error("Missing Authorization header");
  }
  const token = authHeader.slice(7);

  // Validate with Clerk API
  const clerkSecretKey = process.env.CLERK_SECRET_KEY;
  if (!clerkSecretKey) throw new Error("Clerk not configured");

  // Use Clerk's verify token endpoint
  const res = await fetch(
    `https://api.clerk.com/v1/tokens/verify`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${clerkSecretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ token }),
    }
  );

  if (!res.ok) {
    throw new Error("Invalid API key");
  }

  const data = (await res.json()) as {
    user_id?: string;
    org_id?: string;
    sub?: string;
  };
  const clerkUserId = data.user_id ?? data.sub ?? "";
  const orgId = data.org_id ?? clerkUserId;

  if (!clerkUserId) throw new Error("Could not extract user from token");
  return { clerkUserId, orgId };
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
      const { clerkUserId } = await verifyClerkApiKey(request);

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

// POST /api/automations/:id/update — skill updates automation code.
http.route({
  path: "/api/automations",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const url = new URL(request.url);
      const parts = url.pathname.split("/");
      // /api/automations/{id}/update
      const automationId = parts[3];
      const action = parts[4];

      if (!automationId) return errorResponse("Automation ID required");

      const { clerkUserId } = await verifyClerkApiKey(request);
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
          id: automationId as Parameters<typeof internal.automations.updateInternal>[0]["id"],
          code: body.code,
          manifest: body.manifest,
          changeNote: body.changeNote,
          clerkUserId,
        });

        return jsonResponse(result);
      }

      if (action === "run") {
        const result = await ctx.runAction(api.runs.trigger, {
          automationId: automationId as Parameters<typeof api.runs.trigger>[0]["automationId"],
          inputs: body.inputs ?? {},
          triggeredBy: "skill",
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

// GET /api/runs/:runId — skill polls run status.
http.route({
  path: "/api/runs",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    try {
      const url = new URL(request.url);
      const runId = url.pathname.split("/")[3];
      if (!runId) return errorResponse("Run ID required");

      const { clerkUserId } = await verifyClerkApiKey(request);
      const user = await ctx.runQuery(api.users.getByClerkId, { clerkUserId });
      if (!user) return errorResponse("User not found", 401);

      const run = await ctx.runQuery(internal.runs.getInternal, {
        runId: runId as Parameters<typeof internal.runs.getInternal>[0]["runId"],
      });

      if (!run) return errorResponse("Run not found", 404);

      return jsonResponse(run);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      return errorResponse(msg, 400);
    }
  }),
});

export default http;
